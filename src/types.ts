export type Tone = "dark" | "light";

export interface MonitorInfo {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
}

export interface EnvReport {
  platform: string;
  iconCount: number;
  autoArrange: boolean;
  iconsVisible: boolean;
  desktopFound: boolean;
  probeError: string | null;
  monitors: MonitorInfo[];
  muted: boolean;
  issues: string[];
  /** 检测到第三方桌面整理工具（非阻塞提示）。 */
  organizerDetected: boolean;
}

/** 桌面标签的几何（CSS 像素，相对单元格）。 */
export interface IconLabel {
  top: number;
  centerX: number;
  /** 桌面标签矩形宽度（CSS 像素）。 */
  width: number;
}

export interface IconView {
  id: number;
  name: string;
  /** 单元格尺寸的全格 RGBA 画布；空字符串表示没有可用图标图。 */
  image: string;
  originalMonitor: number;
  /** 桌面标签几何；null 表示没检测到标签。 */
  label: IconLabel | null;
}

/** 桌面图标标签字体。 */
export interface LabelFont {
  family: string;
  sizePx: number;
  weight: number;
}

export interface SlotView {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  screenX: number;
  screenY: number;
  screenW: number;
  screenH: number;
  tone: Tone;
}

export interface GlobalSlotView {
  id: number;
  monitor: number;
  screenX: number;
  screenY: number;
  screenW: number;
  screenH: number;
}

export interface RoundResult {
  correct: number;
  total: number;
  accuracy: number;
  elapsedMs: number;
  moves: number;
}

export interface PublicState {
  placements: (number | null)[];
  remaining: number;
  moves: number;
  startedAtMs: number;
  finished: boolean;
  result: RoundResult | null;
  muted: boolean;
  locale: string;
}

export interface OverlayView {
  monitor: MonitorInfo;
  isPrimary: boolean;
  slots: SlotView[];
  globalSlots: GlobalSlotView[];
  icons: IconView[];
  state: PublicState;
  total: number;
  mock: boolean;
  labelFont: LabelFont;
}

export interface DragHover {
  slot: number | null;
}

export interface StartResponse {
  total: number;
  overlays: number;
}

export interface AppErrorPayload {
  code: string;
  detail?: string | null;
}

export interface CaptureProgress {
  done: number;
  total: number;
}