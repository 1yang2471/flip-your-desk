/** 演一段可取消的动画再执行回调。不知道什么是退出/保存，只认元素与类名。 */
export const REVEAL_MS = 1000;
/** 单张卡翻回时长，与 styles.css 的 card-reveal / rotate 过渡一致。 */
const REVEAL_CARD_MS = 320;

export class ExitChoreography {
  private readonly cards: HTMLElement[];
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private timer: number | null = null;
  private cardTimers: number[] = [];
  private then: (() => void) | null = null;
  private readonly perCard: number;

  constructor(cards: HTMLElement[]) {
    this.cards = cards;
    // 最后一张也要在 REVEAL_MS 内翻完：逐卡延迟按「总时长 - 单卡时长」均摊。
    // 直接用总时长除卡片数时，40 张牌最后一张要到 975ms 才起演，320ms 的
    // 翻回动画刚开始就被退出命令打断。
    const spread = cards.length > 1 ? (REVEAL_MS - REVEAL_CARD_MS) / (cards.length - 1) : 0;
    this.perCard = Math.min(60, spread);
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
