use crate::model::{IconRecord, MonitorInfo, RectI, SlotView};

/// 牌面在单元格内收缩的 CSS 像素，留出壁纸缝隙。
pub const CARD_INSET: f64 = 3.0;

pub fn card_rect_css(cell: RectI, monitor: &MonitorInfo, inset: f64) -> (f64, f64, f64, f64) {
    let scale = if monitor.scale > 0.0 {
        monitor.scale
    } else {
        1.0
    };
    let x = (cell.x - monitor.x) as f64 / scale + inset;
    let y = (cell.y - monitor.y) as f64 / scale + inset;
    let w = (cell.w as f64 / scale - inset * 2.0).max(24.0);
    let h = (cell.h as f64 / scale - inset * 2.0).max(24.0);
    (x, y, w, h)
}

pub fn monitor_for_cell(cell: RectI, monitors: &[MonitorInfo]) -> usize {
    let (cx, cy) = cell.center();
    for monitor in monitors {
        if monitor.rect().contains(cx, cy) {
            return monitor.index;
        }
    }
    // 跨屏边缘或显示器列表与 Win32 坐标不一致时，取中心距离最近的显示器。
    monitors
        .iter()
        .min_by_key(|monitor| {
            let rect = monitor.rect();
            let mx = rect.x + rect.w / 2;
            let my = rect.y + rect.h / 2;
            (cx - mx).abs() as i64 + (cy - my).abs() as i64
        })
        .map(|monitor| monitor.index)
        .unwrap_or(0)
}

pub fn slot_views(
    icons: &[IconRecord],
    monitors: &[MonitorInfo],
    monitor_index: usize,
) -> Vec<SlotView> {
    let Some(monitor) = monitors.iter().find(|m| m.index == monitor_index) else {
        return Vec::new();
    };
    icons
        .iter()
        .filter(|icon| icon.monitor == monitor_index)
        .map(|icon| {
            let (x, y, w, h) = card_rect_css(icon.cell, monitor, CARD_INSET);
            SlotView {
                id: icon.id,
                x,
                y,
                w,
                h,
                screen_x: icon.cell.x,
                screen_y: icon.cell.y,
                screen_w: icon.cell.w,
                screen_h: icon.cell.h,
                tone: icon.tone,
            }
        })
        .collect()
}

/// 全局物理坐标命中哪个槽位；多张牌重叠时取中心最近的一张。
/// 前端做实时命中测试，后端保留这份实现用于校验与单元测试。
#[allow(dead_code)]
pub fn hit_test(slots: &[SlotView], global_x: i32, global_y: i32) -> Option<u32> {
    slots
        .iter()
        .filter(|slot| {
            global_x >= slot.screen_x
                && global_x < slot.screen_x + slot.screen_w
                && global_y >= slot.screen_y
                && global_y < slot.screen_y + slot.screen_h
        })
        .min_by_key(|slot| {
            let cx = slot.screen_x + slot.screen_w / 2;
            let cy = slot.screen_y + slot.screen_h / 2;
            (global_x - cx).abs() as i64 + (global_y - cy).abs() as i64
        })
        .map(|slot| slot.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Tone;

    fn monitor() -> MonitorInfo {
        MonitorInfo {
            index: 0,
            name: "test".into(),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
            primary: true,
        }
    }

    #[test]
    fn card_rect_insets_by_css_pixels() {
        let (x, y, w, h) = card_rect_css(
            RectI {
                x: 14,
                y: 2,
                w: 76,
                h: 100,
            },
            &monitor(),
            CARD_INSET,
        );
        assert!((x - 17.0).abs() < 1e-6);
        assert!((y - 5.0).abs() < 1e-6);
        assert!((w - 70.0).abs() < 1e-6);
        assert!((h - 94.0).abs() < 1e-6);
    }

    #[test]
    fn card_rect_scales_with_dpi() {
        let mut monitor = monitor();
        monitor.scale = 1.5;
        let (x, y, w, h) = card_rect_css(
            RectI {
                x: 21,
                y: 3,
                w: 114,
                h: 150,
            },
            &monitor,
            CARD_INSET,
        );
        assert!((x - 17.0).abs() < 1e-6);
        assert!((y - 5.0).abs() < 1e-6);
        assert!((w - 70.0).abs() < 1e-6);
        assert!((h - 94.0).abs() < 1e-6);
    }

    #[test]
    fn negative_origin_monitor_maps_correctly() {
        let monitor = MonitorInfo {
            index: 1,
            name: "left".into(),
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
            primary: false,
        };
        let (x, y, _, _) = card_rect_css(
            RectI {
                x: -1900,
                y: 10,
                w: 76,
                h: 100,
            },
            &monitor,
            CARD_INSET,
        );
        assert!((x - 23.0).abs() < 1e-6);
        assert!((y - 13.0).abs() < 1e-6);
    }

    #[test]
    fn hit_test_prefers_nearest_center() {
        let slots = vec![
            SlotView {
                id: 0,
                x: 0.0,
                y: 0.0,
                w: 70.0,
                h: 94.0,
                screen_x: 0,
                screen_y: 0,
                screen_w: 76,
                screen_h: 100,
                tone: Tone::Dark,
            },
            SlotView {
                id: 1,
                x: 70.0,
                y: 0.0,
                w: 70.0,
                h: 94.0,
                screen_x: 70,
                screen_y: 0,
                screen_w: 76,
                screen_h: 100,
                tone: Tone::Dark,
            },
        ];
        assert_eq!(hit_test(&slots, 74, 50), Some(1));
        assert_eq!(hit_test(&slots, 10, 50), Some(0));
        assert_eq!(hit_test(&slots, 300, 300), None);
    }
}
