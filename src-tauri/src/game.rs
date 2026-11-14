use std::time::{Instant, SystemTime, UNIX_EPOCH};

use rand::seq::SliceRandom;
use rand::{thread_rng, Rng};

use crate::error::{AppError, AppResult};
use crate::geometry;
use crate::model::{
    GlobalSlotView, IconRecord, IconView, IconWrite, LabelBox, LabelFont, LabelView, MonitorInfo,
    OverlayView, PublicState, RectI, RoundResult, Snapshot, Tone,
};

/// 限时公式：T = (30 + 5 × 图标数) 秒。常量集中此处，实测后可调。
pub fn time_limit_ms(icon_count: usize) -> u64 {
    (30 + 5 * icon_count as u64) * 1000
}

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
    /// 限时模式：true 时 HUD 倒计时、超时自动结算（前端心跳到点触发 finish_timed_out）。
    pub timed: bool,
}

impl Round {
    pub fn new(snapshot: Snapshot, locale: String, muted: bool, mock: bool, timed: bool) -> Self {
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
            timed,
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
        // 拖回原位不是一步：只在真正交换时计数。
        if from != to {
            self.placements.swap(from, to);
            self.moves += 1;
        }
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
            timed_out: false,
        };
        self.result = Some(result.clone());
        Ok(result)
    }

    /// 限时模式：时间耗尽的结算——绕过正常 finish 的两个拒绝条件（池清空/
    /// 槽位填满），只计已放对的；未放的槽位计为错。elapsed = 限时公式值。
    pub fn finish_timed_out(&mut self) -> AppResult<RoundResult> {
        if !self.timed {
            return Err(AppError::new("not_timed"));
        }
        if self.result.is_some() {
            return self
                .result
                .clone()
                .ok_or_else(|| AppError::new("round_finished"));
        }
        let limit = time_limit_ms(self.total());
        let total = self.total();
        let correct = (0..total)
            .filter(|&slot| self.placements[slot] == Some(slot as u32))
            .count();
        let accuracy = if total == 0 {
            0
        } else {
            ((correct as f64 / total as f64) * 100.0).round() as u32
        };
        let result = RoundResult {
            correct,
            total,
            accuracy,
            elapsed_ms: limit,
            moves: self.moves,
            timed_out: true,
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
            limit_ms: if self.timed {
                time_limit_ms(self.total())
            } else {
                0
            },
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
        let slots =
            geometry::slot_views(&self.snapshot.icons, &self.snapshot.monitors, monitor_index);
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
                // 标签几何是物理像素；换成该图标所在显示器的 CSS 像素。
                label: icon.label.map(|label| {
                    let scale = self
                        .snapshot
                        .monitors
                        .iter()
                        .find(|monitor| monitor.index == icon.monitor)
                        .map(|monitor| {
                            if monitor.scale > 0.0 {
                                monitor.scale
                            } else {
                                1.0
                            }
                        })
                        .unwrap_or(1.0);
                    LabelView {
                        top: label.top as f64 / scale,
                        center_x: label.center_x as f64 / scale,
                        width: label.width as f64 / scale,
                    }
                }),
            })
            .collect::<Vec<_>>();
        Ok(OverlayView {
            is_primary: monitor.primary,
            slots,
            global_slots,
            icons,
            state: self.public_state(),
            total: self.total(),
            monitor,
            mock: self.mock,
            label_font: self.snapshot.label_font.clone(),
        })
    }

    /// 保存新布局：placed[slot] 的图标应移动到 slot 原本所在的物理位置。
    /// 目标以图标名为身份写回，玩到一半图标增删/改名也不会写错对象。
    pub fn new_layout_positions(&self) -> AppResult<Vec<IconWrite>> {
        if self.result.is_none() {
            return Err(AppError::new("round_not_finished"));
        }
        let mut positions = Vec::with_capacity(self.total());
        for (slot, placed) in self.placements.iter().enumerate() {
            let Some(icon_id) = placed else {
                return Err(AppError::new("not_all_placed"));
            };
            let cell = self.snapshot.icons[slot].cell;
            let icon = &self.snapshot.icons[*icon_id as usize];
            positions.push(IconWrite {
                name: icon.name.clone(),
                x: cell.x,
                y: cell.y,
                // 图标原位置 = 它开局所在的格（同名图标靠它消歧）。
                orig_x: icon.cell.x,
                orig_y: icon.cell.y,
            });
        }
        Ok(positions)
    }

    /// 恢复原布局：每个图标回到自己的原始单元格。
    pub fn original_positions(&self) -> Vec<IconWrite> {
        self.snapshot
            .icons
            .iter()
            .map(|icon| IconWrite {
                name: icon.name.clone(),
                x: icon.cell.x,
                y: icon.cell.y,
                orig_x: icon.cell.x,
                orig_y: icon.cell.y,
            })
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

/// 仅用于开发调试：在本机屏幕上生成 12 张假牌，不触碰真实桌面。
pub fn mock_snapshot(monitors: &[MonitorInfo]) -> Snapshot {
    let names = [
        "Projects",
        "Invoices",
        "Screenshots",
        "Notes",
        "Music",
        "Camera",
        "Downloads",
        "Archive",
        "Sketches",
        "Slides",
        "Budget",
        "Links",
    ];
    let primary = monitors
        .iter()
        .find(|monitor| monitor.primary)
        .or_else(|| monitors.first());
    let Some(primary) = primary else {
        return Snapshot {
            icons: Vec::new(),
            monitors: monitors.to_vec(),
            label_font: LabelFont::default(),
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
                label: Some(LabelBox {
                    top: 54,
                    center_x: 38,
                    width: 76,
                }),
            }
        })
        .collect::<Vec<_>>();
    Snapshot {
        icons,
        monitors: monitors.to_vec(),
        label_font: LabelFont::default(),
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
        let mut round = Round::new(snapshot, "zh-CN".into(), true, true, false);
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
    fn time_limit_formula_centered() {
        assert_eq!(time_limit_ms(24), 150_000);
        assert_eq!(time_limit_ms(1), 35_000);
        assert_eq!(time_limit_ms(120), 630_000);
    }

    #[test]
    fn timeout_finish_scores_placed_only_and_marks_timeout() {
        let snapshot = mock_snapshot(&test_monitors());
        let mut round = Round::new(snapshot, "zh-CN".into(), true, true, true);
        round.begin();
        round.draw(0).unwrap();
        round.placements[0] = Some(0);
        // 池未清空、槽位未填满——超时结算绕过两个拒绝条件，只计已放好的。
        let result = round.finish_timed_out().unwrap();
        assert!(result.timed_out);
        assert_eq!(result.correct, 1);
        assert_eq!(result.total, round.total());
        assert_eq!(result.elapsed_ms, time_limit_ms(round.total()));
    }

    #[test]
    fn normal_finish_still_rejects_and_reports_no_timeout() {
        let mut round = test_round();
        round.draw(0).unwrap();
        assert_eq!(round.finish().unwrap_err().code, "not_all_drawn");
        let mut round = test_round();
        let total = round.total();
        for slot in 0..total {
            round.draw(slot as u32).unwrap();
        }
        let result = round.finish().unwrap();
        assert!(!result.timed_out);
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
        round.move_card(0, 1).unwrap();
        round.finish().unwrap();
        let positions = round.new_layout_positions().unwrap();
        let slot1 = round.snapshot.icons[1].cell;
        let icon0 = positions
            .iter()
            .find(|write| write.name == round.snapshot.icons[0].name)
            .unwrap();
        assert_eq!((icon0.x, icon0.y), (slot1.x, slot1.y));
    }

    #[test]
    fn positions_carry_icon_names() {
        let round = test_round();
        let original = round.original_positions();
        let icon0 = &round.snapshot.icons[0];
        assert_eq!(original[0].name, icon0.name);
        assert_eq!((original[0].x, original[0].y), (icon0.cell.x, icon0.cell.y));
    }

    #[test]
    fn move_to_same_slot_does_not_count() {
        let mut round = test_round();
        round.placements = (0..round.total()).map(|i| Some(i as u32)).collect();
        round.pool.clear();
        round.move_card(2, 2).unwrap();
        assert_eq!(round.moves, 0);
    }
}
