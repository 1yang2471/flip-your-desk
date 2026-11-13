/**
 * 合成音效：无音频文件，首次交互时才创建 AudioContext。
 * 所有声部汇入 masterGain → 限幅器 → 输出，静音时立即把主增益降到 0，
 * 已排期的音也会被掐断；同类音效有最小间隔，避免快速连点糊成一团。
 */
const MUTE_KEY = "fyd.muted";
const MASTER_VOLUME = 0.8;
const MIN_INTERVAL_MS = 40;

/** 启动窗与覆盖层共享同一个静音偏好。 */
export function storedMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function storeMuted(muted: boolean): void {
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

  /** 同类音效节流：快速连点时不叠加成一团。 */
  private allowed(kind: string): boolean {
    const now = performance.now();
    const last = this.lastPlayed.get(kind) ?? -Infinity;
    if (now - last < MIN_INTERVAL_MS) return false;
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

  private noise(duration: number, gainValue: number, frequency: number): void {
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
    filter.type = "bandpass";
    filter.frequency.value = frequency;
    filter.Q.value = 0.8;
    const gain = context.createGain();
    gain.gain.value = gainValue;
    source.connect(filter).connect(gain).connect(output);
    source.start();
  }

  flip(): void {
    if (!this.allowed("flip")) return;
    this.noise(0.07, 0.06, 1600);
    this.tone(420, 0.09, 0.035, "triangle", 0, 240);
  }

  pickup(): void {
    if (!this.allowed("pickup")) return;
    this.tone(280, 0.05, 0.035, "sine", 0, 340);
  }

  drop(): void {
    if (!this.allowed("drop")) return;
    this.tone(190, 0.07, 0.045, "sine", 0, 150);
    this.noise(0.028, 0.025, 900);
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
