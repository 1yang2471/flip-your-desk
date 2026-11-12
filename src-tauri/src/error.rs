use std::fmt;

use serde::Serialize;

/// 命令错误：code 用于前端本地化，detail 只用于诊断展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            detail: None,
        }
    }

    pub fn with_detail(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            detail: Some(detail.into()),
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(detail) => write!(f, "{}: {}", self.code, detail),
            None => write!(f, "{}", self.code),
        }
    }
}

impl std::error::Error for AppError {}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        AppError::with_detail("tauri", value.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;