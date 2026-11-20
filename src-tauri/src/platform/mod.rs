use crate::model::{IconRecord, LabelFont};

pub struct ProbeData {
    pub icon_count: usize,
    pub auto_arrange: bool,
    pub icons_visible: bool,
    pub desktop_found: bool,
    pub permission_denied: bool,
    /// 探测/打开桌面失败的非权限类错误码，前端走 error.* 文案展示。
    pub error_code: Option<String>,
    #[allow(dead_code)]
    pub detail: Option<String>,
}

pub struct Captured {
    pub icons: Vec<IconRecord>,
    pub label_font: LabelFont,
}

/// 写回结果：moved 为成功写回的图标数，failed_write 为写入被拒的名字。
/// 目标缺失/屏外属于写前预检错误，整批不动，不会出现在这个报告里。
pub struct ApplyReport {
    pub moved: usize,
    pub failed_write: Vec<String>,
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{
    apply_positions, capture, detect_desktop_organizers, monitor_work_area,
    pin_window_over_desktop, probe, set_icons_visible,
};

#[cfg(not(windows))]
mod unsupported;
#[cfg(not(windows))]
pub use unsupported::{
    apply_positions, capture, detect_desktop_organizers, monitor_work_area,
    pin_window_over_desktop, probe, set_icons_visible,
};
