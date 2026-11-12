use serde::{Deserialize, Serialize};

/// 物理像素矩形（屏幕坐标）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectI {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl RectI {
    pub fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }

    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

impl MonitorInfo {
    pub fn rect(&self) -> RectI {
        RectI {
            x: self.x,
            y: self.y,
            w: self.width as i32,
            h: self.height as i32,
        }
    }
}

/// 卡背色调：Dark = 深色卡背（壁纸偏亮时使用），Light = 浅色卡背。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Dark,
    Light,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconRecord {
    pub id: u32,
    pub name: String,
    /// PNG data URL；空字符串表示没有可用的图标图，由前端画字母占位。
    pub image: String,
    /// 该图标原始单元格的屏幕物理像素矩形。
    pub cell: RectI,
    pub monitor: usize,
    pub tone: Tone,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub icons: Vec<IconRecord>,
    pub monitors: Vec<MonitorInfo>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvReport {
    pub platform: String,
    pub icon_count: usize,
    pub auto_arrange: bool,
    pub icons_visible: bool,
    pub desktop_found: bool,
    pub monitors: Vec<MonitorInfo>,
    pub muted: bool,
    pub mock: bool,
    /// 稳定的问题码，前端负责本地化文案。
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundResult {
    pub correct: usize,
    pub total: usize,
    pub accuracy: u32,
    pub elapsed_ms: u64,
    pub moves: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicState {
    pub placements: Vec<Option<u32>>,
    pub remaining: usize,
    pub moves: u32,
    pub started_at_ms: u64,
    pub finished: bool,
    pub result: Option<RoundResult>,
    pub muted: bool,
    pub locale: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotView {
    pub id: u32,
    /// 相对本显示器左上角的 CSS 像素。
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 跨屏拖拽命中测试用的屏幕物理像素矩形。
    pub screen_x: i32,
    pub screen_y: i32,
    pub screen_w: i32,
    pub screen_h: i32,
    pub tone: Tone,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconView {
    pub id: u32,
    pub name: String,
    pub image: String,
    pub original_monitor: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSlotView {
    pub id: u32,
    pub monitor: usize,
    pub screen_x: i32,
    pub screen_y: i32,
    pub screen_w: i32,
    pub screen_h: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayView {
    pub monitor: MonitorInfo,
    pub is_primary: bool,
    pub slots: Vec<SlotView>,
    pub global_slots: Vec<GlobalSlotView>,
    pub icons: Vec<IconView>,
    pub state: PublicState,
    pub total: usize,
    pub mock: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragHover {
    pub slot: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResponse {
    pub total: usize,
    pub overlays: usize,
}
