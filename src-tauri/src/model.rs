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
    /// 单元格尺寸的 RGBA PNG（物理像素）；图标贴在其格内原始位置，其余透明。
    pub image: String,
    /// 该图标原始单元格的屏幕物理像素矩形。
    pub cell: RectI,
    pub monitor: usize,
    /// 卡背色调（按壁纸亮度）。
    pub tone: Tone,
    /// 桌面标签的几何（相对单元格的物理像素）；None = 没检测到标签。
    pub label: Option<LabelBox>,
}

/// 桌面图标标签的几何：文字首行像素带顶边与水平中心。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelBox {
    pub top: i32,
    pub center_x: i32,
    /// 桌面标签矩形的宽度（物理像素），可大于格宽：Explorer 允许文字溢出。
    pub width: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub icons: Vec<IconRecord>,
    pub monitors: Vec<MonitorInfo>,
    /// 桌面图标标签的字体（开局时从系统读取，整局固定）。
    pub label_font: LabelFont,
}

/// 桌面图标标签字体：字族 + 逻辑像素字号 + 字重。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelFont {
    pub family: String,
    pub size_px: f64,
    pub weight: i32,
}

impl Default for LabelFont {
    fn default() -> Self {
        Self {
            family: "Segoe UI".into(),
            size_px: 12.0,
            weight: 400,
        }
    }
}

/// 写回桌面的目标：以图标名为身份（玩到一半图标增删/改名都不会写错对象），
/// 位置为该图标应落到的屏幕物理坐标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconWrite {
    pub name: String,
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvReport {
    pub platform: String,
    pub icon_count: usize,
    pub auto_arrange: bool,
    pub icons_visible: bool,
    pub desktop_found: bool,
    /// 探测阶段就失败时的原始错误码；此时 icon_count 等字段不可信。
    pub probe_error: Option<String>,
    pub monitors: Vec<MonitorInfo>,
    pub muted: bool,
    /// 稳定的问题码，前端负责本地化文案。
    pub issues: Vec<String>,
    /// 检测到第三方桌面整理工具（非阻塞提示，由前端展示）。
    pub organizer_detected: bool,
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
    /// 桌面标签几何（CSS 像素，相对单元格）。
    pub label: Option<LabelView>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelView {
    pub top: f64,
    pub center_x: f64,
    pub width: f64,
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
    /// 桌面标签字体（卡面名字按它渲染）。
    pub label_font: LabelFont,
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
