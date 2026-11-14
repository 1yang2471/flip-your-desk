/** 空闲计时 → onIdle。窗口不可见时不触发（最小化时不空转动画）。 */
export const IDLE_MS = 8000;

interface PresenceOptions {
  onIdle?: () => void;
  idleMs?: number;
}

export class PresenceController {
  private readonly onIdle?: () => void;
  private readonly idleMs: number;
  private timer: number | null = null;
  private hidden = false;
  private disposed = false;

  private readonly handleVisibility = (): void => {
    this.hidden = document.visibilityState === "hidden";
    if (this.hidden) this.stopTimer();
    else this.resetIdle();
  };

  constructor(options: PresenceOptions = {}) {
    this.onIdle = options.onIdle;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.hidden = document.visibilityState === "hidden";
    document.addEventListener("visibilitychange", this.handleVisibility);
    this.resetIdle();
  }

  /** 任何用户操作后调用：重新起算空闲。 */
  resetIdle(): void {
    if (this.disposed || this.hidden) return;
    this.stopTimer();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (!this.disposed && !this.hidden) this.onIdle?.();
    }, this.idleMs);
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    document.removeEventListener("visibilitychange", this.handleVisibility);
  }
}
