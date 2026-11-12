use crate::error::AppResult;
use crate::model::{IconRecord, MonitorInfo};

pub struct ProbeData {
    pub icon_count: usize,
    pub auto_arrange: bool,
    pub icons_visible: bool,
    pub desktop_found: bool,
    pub permission_denied: bool,
    pub detail: Option<String>,
}

pub struct Captured {
    pub icons: Vec<IconRecord>,
    /// 每台显示器一张干净壁纸（JPEG data URL），下标与 monitors.index 对应。
    pub wallpaper: Vec<Option<String>>,
    pub fingerprint: String,
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{apply_positions, capture, fingerprint, probe, verify_positions};

#[cfg(not(windows))]
mod unsupported;
#[cfg(not(windows))]
pub use unsupported::{apply_positions, capture, fingerprint, probe, verify_positions};

pub type LayoutPositions = Vec<(u32, i32, i32)>;

#[allow(dead_code)]
fn unsupported_capture(_monitors: &[MonitorInfo]) -> AppResult<Captured> {
    Err(crate::error::AppError::new("unsupported_platform"))
}