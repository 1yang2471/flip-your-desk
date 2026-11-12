use std::time::{Instant, SystemTime, UNIX_EPOCH};

use rand::seq::SliceRandom;
use rand::thread_rng;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::geometry;
use crate::model::{
    EnvReport, GlobalSlotView, IconRecord, IconView, MonitorInfo, OverlayView, PublicState, RectI,
    RoundResult, Snapshot, Tone,
};

#[derive(Debug, Clone)]
pub struct Round {
    pub snapshot: Snapshot,
    /// placements[slot] = 该槽位当前放的图标 id；槽位 id 就是该位置原本的图标 id。
    pub placements: Vec<Option<u32>>,
    pub pool: Vec<u32>,
    pub moves: u32,
    pub started: Option<Instant>,
    pub started_at_ms: u64,
    pub result: Option<RoundResult>,
    pub locale: String,
    pub muted: bool,
    pub mock: bool,
}

impl Round {
    pub fn new(snapshot: Snapshot, locale: String, muted: bool, mock: bool) -> Self {
        let mut pool: Vec<u32> = snapshot.icons.iter().map(|icon| icon.id).collect();
        pool.shuffle(&mut thread_rng());
        Self {
            placements: vec![None; snapshot.icons.len()],
            pool,
            moves: 0,
            started: None,
            started_at_ms: 0,
            result: None,
            snapshot,
            locale,
            muted,
            mock,
        }
    }

    pub fn total(&self) -> usize {
        self.snapshot.icons.len()
    }

    pub fn begin(&mut self) {
        if self.started.is_none() {
            self.started = Some(Instant::now());
            self.started_at_ms = now_ms();
        }
    }

    pub fn draw(&mut self, slot: u32) -> AppResult<()> {
        if self.result.is_some() {
            return Err(AppError::new("round_finished"));
        }
        let idx = slot as usize;
        if idx >= self.placements.len() {
            return Err(AppError::new("invalid_slot"));
        }
        if self.placements[idx].is_some() {
            return Err(AppError::new("slot_filled"));
        }
        if self.pool.is_empty() {
            return Err(AppError::new("all_drawn"));
        }
        let pick = thread_rng().gen_range(0..self.pool.len());
        let icon = self.pool.swap_remove(pick);
        self.placements[idx] = Some(icon);
        self.moves += 1;
        Ok(())
    }

    pub fn move_card(&mut self, from_slot: u32, to_slot: u32) -> AppResult<()> {
        if self.result.is_some() {
            return Err(AppError::new("round_finished"));
        }
        let from = from_slot as usize;
        let to = to_slot as usize;
        if from >= self.placements.len() || to >= self.placements.len() {
            return Err(AppError::new("invalid_slot"));
        }
        if self.placements[from].is_none() {
            return Err(AppError::new("empty_slot"));
        }
        if from != to {
            self.placements.swap(from, to);
        }
        self.moves += 1;
        Ok(())
    }

    pub fn finish(&mut self) -> AppResult<RoundResult> {
        if self.result.is_some() {
            return self
                .result
                .clone()
                .ok_or_else(|| AppError::new("round_finished"));
        }
        if !self.pool.is_empty() {
            return Err(AppError::new("not_all_drawn"));
        }
        if self.placements.iter().any(|slot| slot.is_none()) {
            return Err(AppError::new("not_all_placed"));
        }
        let total = self.total();
        let correct = (0..total)
            .filter(|&slot| self.placements[slot] == Some(slot as u32))
            .count();
        let accuracy = if total == 0 {
            0
        } else {
            ((correct as f64 / total as f64) * 100.0).round() as u32
        };
        let elapsed_ms = self
            .started
            .map(|started| started.elapsed().as_millis() as u64)
            .unwrap_or(0);
        let result = RoundResult {
            correct,
            total,
            accuracy,
            elapsed_ms,
            moves: self.moves,
        };
        self.result = Some(result.clone());
        Ok(result)
    }

    pub fn replay(&mut self) {
        let mut pool: Vec<u32> = self.snapshot.icons.iter().map(|icon| icon.id).collect();
        pool.shuffle(&mut thread_rng());
        self.placements = vec![None; self.snapshot.icons.len()];
        self.pool = pool;
        self.moves = 0;
        self.result = None;
        self.started = Some(Instant::now());
        self.started_at_ms = now_ms();
    }

    pub fn public_state(&self) -> PublicState {
        PublicState {
            placements: self.placements.clone(),
            remaining: self.pool.len(),
            moves: self.moves,
            started_at_ms: self.started_at_ms,
            finished: self.result.is_some(),
            result: self.result.clone(),
            muted: self.muted,
            locale: self.locale.clone(),
        }
    }

    pub fn overlay_view(&self, monitor_index: usize) -> AppResult<OverlayView> {
        let monitor = self
            .snapshot
            .monitors
            .iter()
            .find(|monitor| monitor.index == monitor_index)
            .cloned()
            .ok_or_else(|| AppError::new("unknown_monitor"))?;
        let slots = geometry::slot_views(&self.snapshot.icons, &self.snapshot.monitors, monitor_index);
        let global_slots = self
            .snapshot
            .icons
            .iter()
            .map(|icon| GlobalSlotView {
                id: icon.id,
                monitor: icon.monitor,
                screen_x: icon.cell.x,
                screen_y: icon.cell.y,
                screen_w: icon.cell.w,
                screen_h: icon.cell.h,
            })
            .collect::<Vec<_>>();
        let icons = self
            .snapshot
            .icons
            .iter()
            .map(|icon| IconView {
                id: icon.id,
                name: icon.name.clone(),
                image: icon.image.clone(),
                original_monitor: icon.monitor,
            })
            .collect::<Vec<_>>();
        Ok(OverlayView {
            is_primary: monitor.primary,
            wallpaper: self
                .snapshot
                .wallpaper
                .get(monitor_index)
                .cloned()
                .flatten(),
            slots,
            global_slots,
            icons,
            state: self.public_state(),
            total: self.total(),
            monitor,
            mock: self.mock,
        })
    }

    /// 保存新布局：图标 placed[slot] 应移动到 slot 原本所在的物理位置。
    pub fn new_layout_positions(&self) -> AppResult<Vec<(u32, i32, i32)>> {
        if self.result.is_none() {
            return Err(AppError::new("round_not_finished"));
        }
        let mut positions = Vec::with_capacity(self.total());
        for (slot, placed) in self.placements.iter().enumerate() {
            let Some(icon_id) = placed else {
                return Err(AppError::new("not_all_placed"));
            };
            let cell = self.snapshot.icons[slot].cell;
            positions.push((*icon_id, cell.x, cell.y));
        }
        Ok(positions)
    }

    /// 恢复原布局：每个图标回到自己的原始单元格。
    pub fn original_positions(&self) -> Vec<(u32, i32, i32)> {
        self.snapshot
            .icons
            .iter()
            .map(|icon| (icon.id, icon.cell.x, icon.cell.y))
            .collect()
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutBackup {
    pub version: u32,
    pub saved_at_ms: u64,
    pub icons: Vec<BackupIcon>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupIcon {
    pub index: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl LayoutBackup {
    pub fn from_round(round: &Round) -> Self {
        Self {
            version: 1,
            saved_at_ms: now_ms(),
            icons: round
                .snapshot
                .icons
                .iter()
                .map(|icon| BackupIcon {
                    index: icon.id,
                    name: icon.name.clone(),
                    x: icon.cell.x,
                    y: icon.cell.y,
                    w: icon.cell.w,
                    h: icon.cell.h,
                })
                .collect(),
        }
    }
}

pub fn empty_env(monitors: Vec<MonitorInfo>, muted: bool) -> EnvReport {
    EnvReport {
        platform: "windows".into(),
        icon_count: 0,
        auto_arrange: false,
        icons_visible: false,
        desktop_found: false,
        monitors,
        muted,
        mock: false,
        issues: vec!["desktop_not_found".into()],
    }
}

/// 仅用于开发调试：在本机屏幕上生成 12 张假牌，不触碰真实桌面。
pub fn mock_snapshot(monitors: &[MonitorInfo]) -> Snapshot {
    let names = [
        "Projects", "Invoices", "Screenshots", "Notes", "Music", "Camera", "Downloads",
        "Archive", "Sketches", "Slides", "Budget", "Links",
    ];
    let primary = monitors
        .iter()
        .find(|monitor| monitor.primary)
        .or_else(|| monitors.first());
    let Some(primary) = primary else {
        return Snapshot {
            icons: Vec::new(),
            wallpaper: Vec::new(),
            monitors: monitors.to_vec(),
            fingerprint: "mock-empty".into(),
        };
    };
    let icons = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let col = (i % 4) as i32;
            let row = (i / 4) as i32;
            IconRecord {
                id: i as u32,
                name: (*name).to_string(),
                image: String::new(),
                cell: RectI {
                    x: primary.x + 60 + col * 110,
                    y: primary.y + 48 + row * 120,
                    w: 76,
                    h: 100,
                },
                monitor: primary.index,
                tone: Tone::Light,
            }
        })
        .collect::<Vec<_>>();
    let wallpaper = monitors.iter().map(|_| None).collect();
    Snapshot {
        icons,
        wallpaper,
        monitors: monitors.to_vec(),
        fingerprint: "mock".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_monitors() -> Vec<MonitorInfo> {
        vec![MonitorInfo {
            index: 0,
            name: "test".into(),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
            primary: true,
        }]
    }

    fn test_round() -> Round {
        let snapshot = mock_snapshot(&test_monitors());
        let mut round = Round::new(snapshot, "zh-CN".into(), true, true);
        round.begin();
        round
    }

    #[test]
    fn draw_fills_slots_and_empties_pool() {
        let mut round = test_round();
        let total = round.total();
        for slot in 0..total {
            round.draw(slot as u32).unwrap();
        }
        assert_eq!(round.pool.len(), 0);
        assert!(round.placements.iter().all(|slot| slot.is_some()));
        assert_eq!(round.moves, total as u32);
        round.finish().unwrap();
        assert!(round.result.is_some());
    }

    #[test]
    fn finish_before_all_drawn_is_rejected() {
        let mut round = test_round();
        round.draw(0).unwrap();
        assert_eq!(round.finish().unwrap_err().code, "not_all_drawn");
    }

    #[test]
    fn identity_placement_scores_100() {
        let mut round = test_round();
        round.placements = (0..round.total()).map(|i| Some(i as u32)).collect();
        round.pool.clear();
        let result = round.finish().unwrap();
        assert_eq!(result.correct, round.total());
        assert_eq!(result.accuracy, 100);
    }

    #[test]
    fn moving_a_card_changes_accuracy() {
        let mut round = test_round();
        round.placements = (0..round.total()).map(|i| Some(i as u32)).collect();
        round.pool.clear();
        round.move_card(0, 1).unwrap();
        let result = round.finish().unwrap();
        assert_eq!(result.correct, round.total() - 2);
    }

    #[test]
    fn move_requires_a_card() {
        let mut round = test_round();
        assert_eq!(round.move_card(0, 1).unwrap_err().code, "empty_slot");
    }

    #[test]
    fn replay_clears_state() {
        let mut round = test_round();
        round.placements = (0..round.total()).map(|i| Some(i as u32)).collect();
        round.pool.clear();
        round.finish().unwrap();
        round.replay();
        assert!(round.placements.iter().all(|slot| slot.is_none()));
        assert_eq!(round.pool.len(), round.total());
        assert_eq!(round.moves, 0);
        assert!(round.result.is_none());
        assert!(round.started_at_ms > 0);
    }

    #[test]
    fn new_layout_uses_slot_positions() {
        let mut round = test_round();
        round.placements = (0..round.total()).map(|i| Some(i as u32)).collect();
        round.pool.clear();
        round.finish().unwrap();
        round.move_card(0, 1).unwrap();
        let positions = round.new_layout_positions().unwrap();
        let icon0 = positions.iter().find(|(id, _, _)| *id == 0).unwrap();
        let slot1 = round.snapshot.icons[1].cell;
        assert_eq!((icon0.1, icon0.2), (slot1.x, slot1.y));
    }

    #[test]
    fn backup_serializes_icon_cells() {
        let round = test_round();
        let backup = LayoutBackup::from_round(&round);
        let json = serde_json::to_string(&backup).unwrap();
        assert!(json.contains("\"icons\""));
        let parsed: LayoutBackup = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.icons.len(), round.total());
        assert_eq!(parsed.icons[0].index, 0);
    }
}