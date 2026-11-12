use crate::model::IconRecord;

pub struct ProbeData {
    pub icon_count: usize,
    pub auto_arrange: bool,
    pub icons_visible: bool,
    pub desktop_found: bool,
    pub permission_denied: bool,
    #[allow(dead_code)]
    pub detail: Option<String>,
}

pub struct Captured {
    pub icons: Vec<IconRecord>,
    pub fingerprint: String,
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{apply_positions, capture, fingerprint, probe, verify_positions, work_area};

#[cfg(not(windows))]
mod unsupported;
#[cfg(not(windows))]
pub use unsupported::{apply_positions, capture, fingerprint, probe, verify_positions, work_area};

pub type LayoutPositions = Vec<(u32, i32, i32)>;
