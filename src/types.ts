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
  monitors: MonitorInfo[];
  muted: boolean;
  mock: boolean;
  issues: string[];
}

export interface IconView {
  id: number;
  name: string;
  image: string;
  originalMonitor: number;
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
  wallpaper: string | null;
  slots: SlotView[];
  globalSlots: GlobalSlotView[];
  icons: IconView[];
  state: PublicState;
  total: number;
  mock: boolean;
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