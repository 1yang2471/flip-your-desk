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
use game::Round;
use model::{
    DragHover, EnvReport, IconWrite, MonitorInfo, OverlayView, PublicState, RoundResult, Snapshot,
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
    /// 保存/恢复正在写回桌面图标位置；期间拒绝退出与游戏命令，防半残桌面。
    writing: bool,
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

fn monitors_of(app: &AppHandle, clamp_work_area: bool) -> AppResult<Vec<MonitorInfo>> {
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
    // 每台显示器刨掉各自的任务栏：覆盖层只盖工作区，任务栏照常可用。
    if clamp_work_area {
        for monitor in infos.iter_mut() {
            if let Some((wx, wy, ww, wh)) =
                platform::monitor_work_area(monitor.x, monitor.y, monitor.width, monitor.height)
            {
                monitor.x = wx;
                monitor.y = wy;
                monitor.width = ww;
                monitor.height = wh;
            }
        }
    }
    Ok(infos)
}

fn build_env_report(app: &AppHandle, muted: bool) -> AppResult<EnvReport> {
    // 启动器展示真实分辨率，不做工作区钳制。
    let monitors = monitors_of(app, false)?;
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
        // 探测失败时 icon_count 不可信，不误报“图标太少”。
        if probe.error_code.is_none() && probe.icon_count < 2 {
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
        probe_error: probe.error_code,
        monitors,
        muted,
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
            let _ = window.destroy();
        }
    }
}

fn create_overlays(app: &AppHandle, monitors: &[MonitorInfo]) -> AppResult<Vec<usize>> {
    // 仅调试：在普通窗口里跑完整流程，避免全屏应用/游戏抢占桌面。
    let test_window =
        cfg!(debug_assertions) && std::env::var_os("FLIP_YOUR_DESK_TEST_WINDOW").is_some();
    let mut created = Vec::new();
    for monitor in monitors {
        let label = format!("overlay-{}", monitor.index);
        let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
            .title("Flip Your Desk")
            .decorations(false)
            // 非置顶：其他窗口可以盖住卡牌正常办公，点击桌面区域卡牌回到前台。
            // 这正是“边玩边处理需要处理的事”的产品形态。
            .always_on_top(false)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .shadow(false)
            .transparent(true)
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
        let (x, y, width, height) = if test_window {
            // 仅调试：固定 900×700 的普通窗口，便于 CDP 自动化与截图。
            const WIDTH: u32 = 900;
            const HEIGHT: u32 = 700;
            (
                monitor.x + (monitor.width.saturating_sub(WIDTH) / 2) as i32,
                monitor.y + (monitor.height.saturating_sub(HEIGHT) / 2) as i32,
                WIDTH,
                HEIGHT,
            )
        } else {
            (monitor.x, monitor.y, monitor.width, monitor.height)
        };
        if let Err(err) = window.set_position(tauri::PhysicalPosition::new(x, y)) {
            // destroy 直接销毁；close 会触发 CloseRequested 处理器静默 exit(0)。
            let _ = window.destroy();
            close_overlays(app, created.len());
            return Err(AppError::with_detail(
                "overlay_position_failed",
                err.to_string(),
            ));
        }
        if let Err(err) = window.set_size(tauri::PhysicalSize::new(width, height)) {
            // destroy 直接销毁；close 会触发 CloseRequested 处理器静默 exit(0)。
            let _ = window.destroy();
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
    let monitors = monitors_of(&app, true)?;
    let mock = mode == "mock";
    if mock && !cfg!(debug_assertions) {
        return Err(AppError::new("mock_not_available"));
    }

    // capture 是重阻塞的 Win32 侦察（跨进程消息 + 两次全屏截图），
    // 放进阻塞线程池，避免占用 async 工作线程拖慢其它窗口的 IPC。
    let snapshot = if mock {
        game::mock_snapshot(&monitors)
    } else {
        let monitors_for_capture = monitors.clone();
        let captured =
            tauri::async_runtime::spawn_blocking(move || platform::capture(&monitors_for_capture))
                .await
                .map_err(AppError::from)??;
        Snapshot {
            icons: captured.icons,
            monitors: monitors.clone(),
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
        if inner.writing {
            return Err(AppError::new("write_in_progress"));
        }
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
        if inner.writing {
            return Err(AppError::new("write_in_progress"));
        }
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
        if inner.writing {
            return Err(AppError::new("write_in_progress"));
        }
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

#[tauri::command]
async fn save_and_exit(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let (positions, original, mock) = {
        let inner = lock_state(&state);
        if inner.writing {
            return Err(AppError::new("write_in_progress"));
        }
        let round = inner
            .round
            .as_ref()
            .ok_or_else(|| AppError::new("no_round"))?;
        (
            round.new_layout_positions()?,
            round.original_positions(),
            round.mock,
        )
    };
    if mock {
        // 演示模式没有真实桌面快照，绝不允许走到写回路径。
        app.exit(0);
        return Ok(());
    }
    {
        let mut inner = lock_state(&state);
        inner.writing = true;
    }
    // 写回可能耗时数秒（每项写入+读回校验），放阻塞线程池，期间 writing
    // 标志挡住退出与游戏命令，防止半残桌面。
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        match platform::apply_positions(&positions) {
            Ok(report) => {
                if !report.skipped_missing.is_empty() {
                    // 玩到一半被删/改名的图标无从移动，就此留在原处，如实记录。
                    eprintln!(
                        "save: moved {}, missing {:?}",
                        report.moved, report.skipped_missing
                    );
                }
                if report.failed_write.is_empty() {
                    None
                } else {
                    let rolled_back = rollback_ok(&original);
                    let detail =
                        format!("moved {}, failed {:?}", report.moved, report.failed_write);
                    Some(if rolled_back {
                        AppError::with_detail("save_failed_restored", detail)
                    } else {
                        AppError::with_detail("save_failed_partial", detail)
                    })
                }
            }
            Err(err) => {
                let rolled_back = rollback_ok(&original);
                Some(if rolled_back {
                    AppError::with_detail("save_failed_restored", err.to_string())
                } else {
                    AppError::with_detail("save_failed_partial", err.to_string())
                })
            }
        }
    })
    .await
    .map_err(AppError::from)?;

    match outcome {
        None => {
            app.exit(0);
            Ok(())
        }
        Some(err) => {
            lock_state(&state).writing = false;
            Err(err)
        }
    }
}

/// 回滚是否真的回到了原布局（逐项校验过才算）。
fn rollback_ok(original: &[IconWrite]) -> bool {
    platform::apply_positions(original)
        .map(|report| report.failed_write.is_empty())
        .unwrap_or(false)
}

#[tauri::command]
async fn restore_and_exit(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let (original, mock) = {
        let inner = lock_state(&state);
        if inner.writing {
            return Err(AppError::new("write_in_progress"));
        }
        let round = inner
            .round
            .as_ref()
            .ok_or_else(|| AppError::new("no_round"))?;
        (round.original_positions(), round.mock)
    };
    if mock {
        app.exit(0);
        return Ok(());
    }
    {
        let mut inner = lock_state(&state);
        inner.writing = true;
    }
    // 游戏进行中从不移动真实图标，恢复只是保险带：无论写回成败都退出，
    // 绝不把用户困在“恢复失败”的重试循环里。
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        if let Err(err) = platform::apply_positions(&original) {
            eprintln!("restore best-effort failed: {err}");
        }
    })
    .await;
    if outcome.is_err() {
        eprintln!("restore worker failed; exiting anyway");
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    if lock_state(&state).writing {
        return Err(AppError::new("write_in_progress"));
    }
    app.exit(0);
    Ok(())
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label().starts_with("overlay-") {
                    let handle = window.app_handle();
                    let state = handle.state::<AppState>();
                    if lock_state(&state).writing {
                        // 写回桌面布局途中 Alt+F4 会留下半残桌面：先挡住。
                        api.prevent_close();
                        return;
                    }
                    // 外部（例如全屏游戏）强制关闭覆盖窗：先挡住，再安全退出，
                    // 避免留下隐藏的启动窗和不可用状态。
                    api.prevent_close();
                    handle.exit(0);
                }
            }
        })
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
