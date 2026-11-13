use crate::error::{AppError, AppResult};
use crate::model::{IconWrite, MonitorInfo};

use super::{ApplyReport, Captured, ProbeData};

pub fn probe() -> ProbeData {
    ProbeData {
        icon_count: 0,
        auto_arrange: false,
        icons_visible: false,
        desktop_found: false,
        permission_denied: false,
        error_code: None,
        detail: Some("Flip Your Desk currently supports Windows only".into()),
    }
}

pub fn capture(_monitors: &[MonitorInfo]) -> AppResult<Captured> {
    Err(AppError::new("unsupported_platform"))
}

pub fn apply_positions(_positions: &[IconWrite]) -> AppResult<ApplyReport> {
    Err(AppError::new("unsupported_platform"))
}

pub fn monitor_work_area(_x: i32, _y: i32, _w: u32, _h: u32) -> Option<(i32, i32, u32, u32)> {
    None
}

pub fn set_icons_visible(_visible: bool) -> AppResult<()> {
    Err(AppError::new("unsupported_platform"))
}

pub fn pin_window_over_desktop(_hwnd: isize) -> AppResult<()> {
    Err(AppError::new("unsupported_platform"))
}
