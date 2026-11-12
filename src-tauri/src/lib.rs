mod error;
mod game;
mod geometry;
mod model;
mod platform;

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use error::{AppError, AppResult};
use game::{LayoutBackup, Round};
use model::{
    DragHover, EnvReport, MonitorInfo, OverlayView, PublicState, RoundResult, Snapshot,
    StartResponse,
};

pub struct AppState {
    inner: Mutex<InnerState>,
}

#[derive(Default)]
struct InnerState {
    round: Option<Round>,
    monitors: Vec<MonitorInfo>,
    ready: HashSet<usize>,
    muted: bool,
    start_token: u64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(InnerState::default()),
        }
    }
}

fn lock_state(state: &AppState) -> std::sync::MutexGuard<'_, InnerState> {
    state
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn monitors_of(app: &AppHandle) -> AppResult<Vec<MonitorInfo>> {
    let window = app
        .get_webview_window("launcher")
        .ok_or_else(|| AppError::new("launcher_missing"))?;
    let primary = window.primary_monitor().ok().flatten();
    let mut monitors = window
        .available_monitors()
        .map_err(|err| AppError::with_detail("monitor_query_failed", err.to_string()))?;
    if monitors.is_empty() {
        return Err(AppError::new("no_monitor"));
    }
    monitors.sort_by_key(|monitor| (monitor.position().x, monitor.position().y));
    let infos = monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let position = monitor.position();
            let size = monitor.size();
            let is_primary = primary
                .as_ref()
                .map(|p| p.position() == position && p.size() == size)
                .unwrap_or(index == 0);
            MonitorInfo {
                index,
                name: monitor
                    .name()
                    .cloned()
                    .unwrap_or_else(|| format!("Display {}", index + 1)),
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                scale: monitor.scale_factor(),
                primary: is_primary,
            }
        })
        .collect::<Vec<_>>();
    // 确保至少有一个 primary，后续 HUD 依赖它。
    let mut infos = infos;
    if !infos.iter().any(|monitor| monitor.primary) {
        if let Some(first) = infos.first_mut() {
            first.primary = true;
        }
    }
    Ok(infos)
}

fn build_env_report(app: &AppHandle, muted: bool) -> AppResult<EnvReport> {
    let monitors = monitors_of(app)?;
    let probe = platform::probe();
    let mut issues = Vec::new();
    if !probe.desktop_found {
        issues.push("desktop_not_found".to_string());
    } else {
        if probe.permission_denied {
            issues.push("permission_denied".to_string());
        }
        if !probe.icons_visible {
            issues.push("icons_hidden".to_string());
        }
        if probe.auto_arrange {
            issues.push("auto_arrange_on".to_string());
        }
        if probe.icon_count < 2 {
            issues.push("too_few_icons".to_string());
        }
    }
    Ok(EnvReport {
        platform: if cfg!(windows) {
            "windows".into()
        } else {
            std::env::consts::OS.to_string()
        },
        icon_count: probe.icon_count,
        auto_arrange: probe.auto_arrange,
        icons_visible: probe.icons_visible,
        desktop_found: probe.desktop_found,
        monitors,
        muted,
        mock: false,
        issues,
    })
}

#[tauri::command]
fn probe_environment(app: AppHandle, state: State<'_, AppState>) -> AppResult<EnvReport> {
    let muted = lock_state(&state).muted;
    build_env_report(&app, muted)
}

fn close_overlays(app: &AppHandle, count: usize) {
    for index in 0..count {
        if let Some(window) = app.get_webview_window(&format!("overlay-{index}")) {
            let _ = window.close();
        }
    }
}

fn create_overlays(app: &AppHandle, monitors: &[MonitorInfo]) -> AppResult<Vec<usize>> {
    let mut created = Vec::new();
    for monitor in monitors {
        let label = format!("overlay-{}", monitor.index);
        let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
            .title("Flip Your Desk")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .shadow(false)
            .visible(false)
            .focused(false);
        let window = match builder.build() {
            Ok(window) => window,
            Err(err) => {
                close_overlays(app, created.len());
                return Err(AppError::with_detail(
                    "overlay_create_failed",
                    err.to_string(),
                ));
            }
        };
        if let Err(err) = window.set_position(tauri::PhysicalPosition::new(monitor.x, monitor.y)) {
            let _ = window.close();
            close_overlays(app, created.len());
            return Err(AppError::with_detail(
                "overlay_position_failed",
                err.to_string(),
            ));
        }
        if let Err(err) = window.set_size(tauri::PhysicalSize::new(monitor.width, monitor.height)) {
            let _ = window.close();
            close_overlays(app, created.len());
            return Err(AppError::with_detail(
                "overlay_size_failed",
                err.to_string(),
            ));
        }
        created.push(monitor.index);
    }
    Ok(created)
}

fn emit_state(app: &AppHandle, state: &PublicState) {
    let _ = app.emit("state-changed", state);
}

#[tauri::command]
async fn start_round(
    app: AppHandle,
    state: State<'_, AppState>,
    locale: String,
    mode: String,
) -> AppResult<StartResponse> {
    let monitors = monitors_of(&app)?;
    let mock = mode == "mock";
    if mock && !cfg!(debug_assertions) {
        return Err(AppError::new("mock_not_available"));
    }

    let snapshot = if mock {
        game::mock_snapshot(&monitors)
    } else {
        let captured = platform::capture(&monitors)?;
        Snapshot {
            icons: captured.icons,
            wallpaper: captured.wallpaper,
            monitors: monitors.clone(),
            fingerprint: captured.fingerprint,
        }
    };
    if snapshot.icons.len() < 2 {
        return Err(AppError::new("too_few_icons"));
    }

    let (muted, token) = {
        let old_count = lock_state(&state).monitors.len();
        close_overlays(&app, old_count);
        let mut inner = lock_state(&state);
        inner.start_token += 1;
        inner.ready.clear();
        let muted = inner.muted;
        (muted, inner.start_token)
    };

    let round = Round::new(snapshot, locale, muted, mock);
    let total = round.total();
    let overlay_count = monitors.len();
    {
        let mut inner = lock_state(&state);
        inner.round = Some(round);
        inner.monitors = monitors.clone();
    }

    if let Err(err) = create_overlays(&app, &monitors) {
        lock_state(&state).round = None;
        return Err(err);
    }

    spawn_overlay_timeout(app.clone(), token, overlay_count);

    Ok(StartResponse {
        total,
        overlays: overlay_count,
    })
}

fn spawn_overlay_timeout(app: AppHandle, token: u64, overlay_count: usize) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(6));
        let state = app.state::<AppState>();
        let mut inner = lock_state(&state);
        if inner.start_token != token || inner.round.is_none() || inner.ready.len() == overlay_count
        {
            return;
        }
        let count = inner.monitors.len();
        inner.round = None;
        drop(inner);
        close_overlays(&app, count);
        if let Some(launcher) = app.get_webview_window("launcher") {
            let _ = launcher.show();
            let _ = launcher.set_focus();
        }
        let _ = app.emit("start-failed", AppError::new("overlay_timeout"));
    });
}

#[tauri::command]
fn overlay_ready(app: AppHandle, state: State<'_, AppState>, monitor: usize) -> AppResult<()> {
    let mut ready = false;
    let mut public = None;
    let mut primary = None;
    {
        let mut inner = lock_state(&state);
        if inner.round.is_none() {
            return Err(AppError::new("no_round"));
        }
        if !inner.monitors.iter().any(|m| m.index == monitor) {
            return Err(AppError::new("unknown_monitor"));
        }
        inner.ready.insert(monitor);
        if inner.ready.len() == inner.monitors.len() {
            if let Some(round) = inner.round.as_mut() {
                round.begin();
                public = Some(round.public_state());
            }
            primary = inner.monitors.iter().find(|m| m.primary).map(|m| m.index);
            ready = true;
        }
    }

    if ready {
        let count = lock_state(&state).monitors.len();
        for index in 0..count {
            if let Some(window) = app.get_webview_window(&format!("overlay-{index}")) {
                let _ = window.show();
            }
        }
        if let Some(index) = primary {
            if let Some(window) = app.get_webview_window(&format!("overlay-{index}")) {
                let _ = window.set_focus();
            }
        }
        if let Some(launcher) = app.get_webview_window("launcher") {
            let _ = launcher.hide();
        }
        if let Some(public) = public {
            emit_state(&app, &public);
        }
    }
    Ok(())
}

#[tauri::command]
fn get_overlay_view(state: State<'_, AppState>, monitor: usize) -> AppResult<OverlayView> {
    let inner = lock_state(&state);
    let round = inner
        .round
        .as_ref()
        .ok_or_else(|| AppError::new("no_round"))?;
    round.overlay_view(monitor)
}

#[tauri::command]
fn draw_card(app: AppHandle, state: State<'_, AppState>, slot: u32) -> AppResult<()> {
    let public = {
        let mut inner = lock_state(&state);
        let round = inner
            .round
            .as_mut()
            .ok_or_else(|| AppError::new("no_round"))?;
        round.draw(slot)?;
        round.public_state()
    };
    emit_state(&app, &public);
    Ok(())
}

#[tauri::command]
fn move_card(
    app: AppHandle,
    state: State<'_, AppState>,
    from_slot: u32,
    to_slot: u32,
) -> AppResult<()> {
    let public = {
        let mut inner = lock_state(&state);
        let round = inner
            .round
            .as_mut()
            .ok_or_else(|| AppError::new("no_round"))?;
        round.move_card(from_slot, to_slot)?;
        round.public_state()
    };
    emit_state(&app, &public);
    Ok(())
}

#[tauri::command]
fn set_drag_hover(app: AppHandle, slot: Option<u32>) {
    let _ = app.emit("drag-hover", DragHover { slot });
}

#[tauri::command]
fn finish_round(app: AppHandle, state: State<'_, AppState>) -> AppResult<RoundResult> {
    let (result, public) = {
        let mut inner = lock_state(&state);
        let round = inner
            .round
            .as_mut()
            .ok_or_else(|| AppError::new("no_round"))?;
        let result = round.finish()?;
        (result, round.public_state())
    };
    emit_state(&app, &public);
    Ok(result)
}

#[tauri::command]
fn replay_round(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let public = {
        let mut inner = lock_state(&state);
        let round = inner
            .round
            .as_mut()
            .ok_or_else(|| AppError::new("no_round"))?;
        round.replay();
        round.public_state()
    };
    emit_state(&app, &public);
    Ok(())
}

#[tauri::command]
fn set_muted(app: AppHandle, state: State<'_, AppState>, muted: bool) -> AppResult<()> {
    let public = {
        let mut inner = lock_state(&state);
        inner.muted = muted;
        if let Some(round) = inner.round.as_mut() {
            round.set_muted(muted);
            Some(round.public_state())
        } else {
            None
        }
    };
    if let Some(public) = public {
        emit_state(&app, &public);
    }
    Ok(())
}

fn write_backup(app: &AppHandle, backup: &LayoutBackup) -> AppResult<std::path::PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| AppError::with_detail("backup_failed", err.to_string()))?;
    std::fs::create_dir_all(&dir)
        .map_err(|err| AppError::with_detail("backup_failed", err.to_string()))?;
    let path = dir.join("original-layout.json");
    let json = serde_json::to_string_pretty(backup)
        .map_err(|err| AppError::with_detail("backup_failed", err.to_string()))?;
    std::fs::write(&path, json)
        .map_err(|err| AppError::with_detail("backup_failed", err.to_string()))?;
    Ok(path)
}

#[tauri::command]
async fn save_and_exit(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let (positions, original, backup, fingerprint, total) = {
        let inner = lock_state(&state);
        let round = inner
            .round
            .as_ref()
            .ok_or_else(|| AppError::new("no_round"))?;
        (
            round.new_layout_positions()?,
            round.original_positions(),
            LayoutBackup::from_round(round),
            round.snapshot.fingerprint.clone(),
            round.total(),
        )
    };
    if positions.len() != total {
        return Err(AppError::new("not_all_placed"));
    }
    let current = platform::fingerprint()?;
    if current != fingerprint {
        return Err(AppError::new("desktop_changed"));
    }
    write_backup(&app, &backup)?;
    match platform::apply_positions(&positions).and_then(|_| platform::verify_positions(&positions))
    {
        Ok(()) => {
            app.exit(0);
            Ok(())
        }
        Err(err) => {
            let _ = platform::apply_positions(&original);
            let _ = platform::verify_positions(&original);
            Err(AppError::with_detail(
                "save_failed_restored",
                err.to_string(),
            ))
        }
    }
}

#[tauri::command]
async fn restore_and_exit(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let (original, fingerprint) = {
        let inner = lock_state(&state);
        let round = inner
            .round
            .as_ref()
            .ok_or_else(|| AppError::new("no_round"))?;
        (
            round.original_positions(),
            round.snapshot.fingerprint.clone(),
        )
    };
    let current = platform::fingerprint()?;
    if current != fingerprint {
        return Err(AppError::new("desktop_changed"));
    }
    platform::apply_positions(&original)?;
    platform::verify_positions(&original)?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn minimize_launcher(app: AppHandle) -> AppResult<()> {
    if let Some(window) = app.get_webview_window("launcher") {
        window
            .minimize()
            .map_err(|err| AppError::with_detail("window_minimize_failed", err.to_string()))?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            probe_environment,
            start_round,
            overlay_ready,
            get_overlay_view,
            draw_card,
            move_card,
            set_drag_hover,
            finish_round,
            replay_round,
            set_muted,
            save_and_exit,
            restore_and_exit,
            quit_app,
            minimize_launcher,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flip Your Desk");
}
