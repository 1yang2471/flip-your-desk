use crate::error::{AppError, AppResult};
use crate::model::MonitorInfo;

use super::{Captured, LayoutPositions, ProbeData};

pub fn probe() -> ProbeData {
    ProbeData {
        icon_count: 0,
        auto_arrange: false,
        icons_visible: false,
        desktop_found: false,
        permission_denied: false,
        detail: Some("Flip Your Desk currently supports Windows only".into()),
    }
}

pub fn capture(_monitors: &[MonitorInfo]) -> AppResult<Captured> {
    Err(AppError::new("unsupported_platform"))
}

pub fn fingerprint() -> AppResult<String> {
    Err(AppError::new("unsupported_platform"))
}

pub fn apply_positions(_positions: &LayoutPositions) -> AppResult<()> {
    Err(AppError::new("unsupported_platform"))
}

pub fn verify_positions(_positions: &LayoutPositions) -> AppResult<()> {
    Err(AppError::new("unsupported_platform"))
}
