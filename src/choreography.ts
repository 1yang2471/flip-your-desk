/** 演一段可取消的动画再执行回调。不知道什么是退出/保存，只认元素与类名。 */
export const REVEAL_MS = 1000;

export class ExitChoreography {
  private readonly cards: HTMLElement[];
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private timer: number | null = null;
  private cardTimers: number[] = [];
  private then: (() => void) | null = null;
  private readonly perCard: number;

  constructor(cards: HTMLElement[]) {
    this.cards = cards;
    this.perCard = cards.length > 0 ? Math.min(60, REVEAL_MS / cards.length) : 0;
  }

  /** 依次给卡片加 .revealing（多米诺），全部完成后才执行 then。 */
  play(then: () => void): void {
    this.cancel();
    this.then = then;
    if (this.reducedMotion.matches) {
      this.finish();
      return;
    }
    this.cards.forEach((card, index) => {
      this.cardTimers.push(window.setTimeout(() => {
        card.classList.add("revealing");
      }, index * this.perCard));
    });
    this.timer = window.setTimeout(() => this.finish(), REVEAL_MS);
  }

  /** 取消：移除所有类、清掉主定时器与逐卡定时器，then 绝不执行。 */
  cancel(): void {
    this.clearTimers();
    this.then = null;
    for (const card of this.cards) card.classList.remove("revealing");
  }

  private clearTimers(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    for (const id of this.cardTimers) window.clearTimeout(id);
    this.cardTimers = [];
  }

  private finish(): void {
    this.clearTimers();
    const then = this.then;
    this.then = null;
    then?.();
  }
}
