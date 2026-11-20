/**
 * 限时模式的本地倒计时。后端 startedAtMs 是所有窗口的共同锚点；只有它为 0
 * （极少数发牌竞态）时才退回本窗口第一次 tick 的时刻，避免整块 HUD 冻在满值。
 *
 * 单独成模块是为了让「重开重置」「到期只触发一次」能被真实行为测试覆盖，
 * 而不是只靠 overlay.ts 的源码形状断言。
 */
export interface TimedTick {
  leftMs: number;
  expired: boolean;
}

export class TimedClock {
  /** startedAtMs 缺失时的本窗口兜底锚点（ms）；0 = 尚未起步。 */
  private fallbackStartedAt = 0;
  private lastStartedAt = 0;
  private fired = false;

  /** 每轮（或每次开始/重开）调用；同一个 startedAt 下只会 expire 一次。 */
  tick(
    limitMs: number,
    startedAtMs: number,
    finished: boolean,
    now = Date.now(),
  ): TimedTick {
    if (limitMs <= 0 || finished) {
      this.reset();
      return { leftMs: 0, expired: false };
    }
    if (startedAtMs !== this.lastStartedAt) {
      this.lastStartedAt = startedAtMs;
      this.fallbackStartedAt = 0;
      this.fired = false;
    }
    if (startedAtMs > 0) {
      this.fallbackStartedAt = 0;
    } else if (this.fallbackStartedAt === 0) {
      this.fallbackStartedAt = now;
    }
    const anchor = startedAtMs > 0 ? startedAtMs : this.fallbackStartedAt;
    // 系统时钟回拨时 elapsed 会变成负数；夹到 [0, limit]，不显示超过上限的时间。
    const leftMs = Math.max(0, Math.min(limitMs, limitMs - (now - anchor)));
    const expired = leftMs === 0 && !this.fired;
    if (expired) this.fired = true;
    return { leftMs, expired };
  }

  reset(): void {
    this.fallbackStartedAt = 0;
    this.lastStartedAt = 0;
    this.fired = false;
  }
}
