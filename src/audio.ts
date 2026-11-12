/**
 * Small synthesized sounds. No audio files, no autoplay: every sound is
 * created from a user gesture.
 */
export class Sounds {
  private context: AudioContext | null = null;
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (this.context) {
      if (this.context.state === "suspended") {
        void this.context.resume();
      }
      return this.context;
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.context = new Ctor();
      return this.context;
    } catch {
      return null;
    }
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
    if (!context) return;
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
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private noise(duration: number, gainValue: number, frequency: number): void {
    const context = this.ensure();
    if (!context) return;
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
    source.connect(filter).connect(gain).connect(context.destination);
    source.start();
  }

  flip(): void {
    this.noise(0.07, 0.06, 1600);
    this.tone(420, 0.09, 0.035, "triangle", 0, 240);
  }

  pickup(): void {
    this.tone(280, 0.05, 0.035, "sine", 0, 340);
  }

  drop(): void {
    this.tone(190, 0.07, 0.045, "sine", 0, 150);
    this.noise(0.028, 0.025, 900);
  }

  finish(): void {
    this.tone(523.25, 0.5, 0.035, "triangle");
    this.tone(783.99, 0.6, 0.03, "triangle", 0.12);
  }

  error(): void {
    this.tone(110, 0.13, 0.04, "sine", 0, 90);
  }
}