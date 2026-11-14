/** 窗口活跃度 → 三个回调。刻意不操作 DOM：加类/移类由 OverlayGame 决定。 */
export const IDLE_MS = 8000;

interface PresenceOptions {
  onHide?: () => void;
  onShow?: () => void;
  onIdle?: () => void;
  idleMs?: number;
}

export class PresenceController {
  private readonly onHide?: () => void;
  private readonly onShow?: () => void;
  private readonly onIdle?: () => void;
  private readonly idleMs: number;
  private timer: number | null = null;
  private hidden = false;
  private disposed = false;

  private readonly handleBlur = (): void => this.setHidden(true);
  private readonly handleFocus = (): void => this.setHidden(false);
  private readonly handleVisibility = (): void => {
    this.setHidden(document.visibilityState === "hidden");
  };

  constructor(options: PresenceOptions = {}) {
    this.onHide = options.onHide;
    this.onShow = options.onShow;
    this.onIdle = options.onIdle;
    this.idleMs = options.idleMs ?? IDLE_MS;
    window.addEventListener("blur", this.handleBlur);
    window.addEventListener("focus", this.handleFocus);
    document.addEventListener("visibilitychange", this.handleVisibility);
    this.resetIdle();
  }

  /** 任何用户操作后调用：重新起算空闲，并解除隐藏态。 */
  resetIdle(): void {
    if (this.disposed) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (!this.hidden) {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        if (!this.disposed && !this.hidden) this.onIdle?.();
      }, this.idleMs);
    }
  }

  private setHidden(hidden: boolean): void {
    if (this.disposed || this.hidden === hidden) return;
    this.hidden = hidden;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (hidden) this.onHide?.();
    else {
      this.onShow?.();
      this.resetIdle();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    window.removeEventListener("blur", this.handleBlur);
    window.removeEventListener("focus", this.handleFocus);
    document.removeEventListener("visibilitychange", this.handleVisibility);
  }
}
