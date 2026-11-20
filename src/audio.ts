/**
 * 合成音效：无音频文件，首次交互时才创建 AudioContext。
 * 所有声部汇入 masterGain → 限幅器 → 输出，静音时立即把主增益降到 0，
 * 已排期的音也会被掐断；同类音效有最小间隔，避免快速连点糊成一团。
 */
const MUTE_KEY = "fyd.muted";
const MASTER_VOLUME = 0.8;
const MIN_INTERVAL_MS = 40;
/** 各声部专用节流：发牌级联逐卡触发，间隔必须小于通用值。 */
const MIN_INTERVALS: Record<string, number> = { deal: 14 };

/** 启动窗与覆盖层共享同一个静音偏好。 */
export function storedMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 启动窗与覆盖层共用：任何一窗切换静音都立即落盘，避免关窗后偏好丢失。 */
export function storeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // 受限上下文里仍保留本次会话的静音状态。
  }
}

export class Sounds {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = storedMuted();
  private lastPlayed = new Map<string, number>();

  setMuted(muted: boolean): void {
    // 每次 state-changed 都会同步静音态；没变化时不要反复写 localStorage/推增益。
    if (this.muted === muted) return;
    this.muted = muted;
    storeMuted(muted);
    // 立即静音：已 start() 但还在排期中的振荡器也要一起停。
    if (this.master && this.context) {
      const now = this.context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(muted ? 0 : MASTER_VOLUME, now + 0.02);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (this.context) {
      if (this.context.state === "suspended") void this.context.resume();
      return this.context;
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    try {
      const context = new Ctor();
      const master = context.createGain();
      master.gain.value = MASTER_VOLUME;
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      master.connect(limiter).connect(context.destination);
      this.context = context;
      this.master = master;
      return context;
    } catch {
      return null;
    }
  }

  /** 同类音效节流：快速连点时不叠加成一团；deal 有更短的专用间隔。 */
  private allowed(kind: string): boolean {
    const now = performance.now();
    const last = this.lastPlayed.get(kind) ?? -Infinity;
    const minInterval = MIN_INTERVALS[kind] ?? MIN_INTERVAL_MS;
    if (now - last < minInterval) return false;
    this.lastPlayed.set(kind, now);
    return true;
  }

  private output(): AudioNode | null {
    return this.master;
  }

  private tone(
    frequency: number,
    duration: number,
    gainValue: number,
    type: OscillatorType = "sine",
    delay = 0,
    endFrequency?: number,
  ): void {
    const context = this.ensure();
    const output = this.output();
    if (!context || !output) return;
    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (endFrequency !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(20, endFrequency),
        start + duration,
      );
    }
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(output);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private noise(
    duration: number,
    gainValue: number,
    frequency: number,
    type: BiquadFilterType = "bandpass",
    endFrequency?: number,
  ): void {
    const context = this.ensure();
    const output = this.output();
    if (!context || !output) return;
    const frames = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(frequency, context.currentTime);
    if (endFrequency !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(40, endFrequency),
        context.currentTime + duration,
      );
    }
    filter.Q.value = 0.8;
    const gain = context.createGain();
    gain.gain.value = gainValue;
    source.connect(filter).connect(gain).connect(output);
    source.start();
  }

  /** ±4% 随机音高倍率：连续操作时去掉打字机式的机械重复感。 */
  private humanize(): number {
    return 1 + (Math.random() * 2 - 1) * 0.04;
  }

  flip(): void {
    if (!this.allowed("flip")) return;
    const h = this.humanize();
    // 纸牌翻动：高频噪声瞬态（弹指）+ 短促下滑三角波。
    this.noise(0.05, 0.05, 4200, "highpass");
    this.tone(430 * h, 0.08, 0.03, "triangle", 0, 230 * h);
  }

  pickup(): void {
    if (!this.allowed("pickup")) return;
    const h = this.humanize();
    // 纸面摩擦：带通噪声中心频率上扫，像把牌从桌面拿起。
    this.noise(0.06, 0.032, 700 * h, "bandpass", 2200 * h);
  }

  drop(): void {
    if (!this.allowed("drop")) return;
    const h = this.humanize();
    // 落卡：低频冲击（牌身拍在桌面）+ lowpass 呢面摩擦尾。
    this.tone(175 * h, 0.06, 0.05, "sine", 0, 118 * h);
    this.noise(0.12, 0.018, 520, "lowpass");
  }

  /** 发牌级联的逐卡 tick：极轻的高频瞬态，与入场动画同步。 */
  dealTick(): void {
    if (!this.allowed("deal")) return;
    this.noise(0.014, 0.028, 6000, "highpass");
  }

  /** 结算和弦：正确率 ≥50 / ≥20 / 其余 三档，音符 C5 E5 G5 C6 及其小调变体。 */
  finish(accuracy = 100): void {
    if (!this.allowed("finish")) return;
    const HIGH = 50;
    const MID = 20;
    if (accuracy >= HIGH) {
      this.tone(523.25, 0.3, 0.035, "triangle");
      this.tone(659.25, 0.3, 0.035, "triangle", 0.1);
      this.tone(783.99, 0.32, 0.035, "triangle", 0.2);
      this.tone(1046.5, 0.55, 0.03, "triangle", 0.3);
    } else if (accuracy >= MID) {
      this.tone(523.25, 0.5, 0.035, "triangle");
      this.tone(783.99, 0.6, 0.03, "triangle", 0.12);
    } else {
      this.tone(392, 0.5, 0.03, "sine");
      this.tone(329.63, 0.6, 0.025, "sine", 0.14);
    }
  }

  error(): void {
    if (!this.allowed("error")) return;
    this.tone(110, 0.13, 0.04, "sine", 0, 90);
  }
}
