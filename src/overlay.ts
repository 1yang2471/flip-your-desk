import { listen } from "@tauri-apps/api/event";

import { api, asAppError } from "./api";
import { Sounds } from "./audio";
import { ExitChoreography } from "./choreography";
import { clear, h, iconEl } from "./dom";
import { PresenceController } from "./presence";
import { studyTick } from "./study";
import { TimedClock } from "./timed";
import {
  detectLang,
  errorText,
  formatDuration,
  isLang,
  pluralKey,
  tDynamic,
  t,
  type Lang,
} from "./i18n";
import type {
  IconView,
  OverlayView,
  PublicState,
  RoundResult,
  SlotView,
} from "./types";

interface DragState {
  iconId: number;
  fromSlot: number;
  element: HTMLButtonElement;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  slotX: number;
  slotY: number;
  armed: boolean;
  hoverSlot: number | null;
  /** 上一事件的指针 x：算水平速度做微倾斜。 */
  lastClientX: number;
  /** 平滑后的倾斜角（度），±3 clamp。 */
  tilt: number;
}

export class OverlayGame {
  private readonly view: OverlayView;
  private readonly root: HTMLElement;
  private readonly lang: Lang;
  private readonly sounds = new Sounds();
  private readonly slots = new Map<number, SlotView>();
  private readonly icons = new Map<number, IconView>();
  private readonly faces = new Map<number, HTMLButtonElement>();
  private readonly backs = new Map<number, HTMLButtonElement>();

  private board!: HTMLDivElement;
  private hudWrap!: HTMLDivElement;
  private hudProgressText!: HTMLSpanElement;
  private hudProgressFill!: HTMLSpanElement;
  private hudTime!: HTMLSpanElement;
  private hudMoves!: HTMLSpanElement;
  private hudHint!: HTMLDivElement;
  private confirmButton!: HTMLButtonElement;
  private studyChip!: HTMLButtonElement;
  private studyRingFill!: SVGCircleElement;
  private studySeconds!: HTMLSpanElement;
  private resultLayer!: HTMLDivElement;
  private exitLayer!: HTMLDivElement;
  private toastElement!: HTMLDivElement;

  private state: PublicState;
  private drag: DragState | null = null;
  private dragListeners: {
    move: (event: Event) => void;
    end: (event: Event) => void;
    cancel: () => void;
  } | null = null;
  private selectedIcon: number | null = null;
  private selectedSlot: number | null = null;
  private targetSlot: number | null = null;
  private pending = false;
  /** armed 拖拽刚结束的短窗口内为 true：挡住 pointerup 派发的 click，避免二次换位。 */
  private suppressClick = false;
  private resultOpen = false;
  private exitOpen = false;
  private toastTimer: number | null = null;
  /** 发牌级联的逐卡 tick 定时器，窗口销毁时统一清理。 */
  private dealTimers: number[] = [];
  private presence: PresenceController | null = null;
  private choreography: ExitChoreography | null = null;
  private readonly clock = new TimedClock();
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  /** 记忆阶段：预览卡、圆环驱动与 board 输入锁。 */
  private studyActive = false;
  private studyFlipping = false;
  private studyAnchor = 0;
  private studySkipPending = false;
  private studyShownSeconds = -1;
  private studyTimer: number | null = null;
  private studyFlipTimer: number | null = null;
  private previews: HTMLElement[] = [];

  constructor(view: OverlayView, root: HTMLElement) {
    this.view = view;
    this.root = root;
    // 开局时启动窗选定的语言是唯一真源；仅在异常缺失时回退到系统检测。
    this.lang = isLang(view.state.locale) ? view.state.locale : detectLang();
    this.state = view.state;
    for (const slot of view.slots) this.slots.set(slot.id, slot);
    for (const icon of view.icons) this.icons.set(icon.id, icon);
  }

  async init(): Promise<void> {
    this.buildShell();
    this.buildHud();
    this.buildBoard();
    this.applyState(this.state, true);
    // 必须先完成事件订阅再报告 ready：最后一个窗口触发 begin() 并广播
    // 记忆阶段状态，订阅晚一拍就会整段错过、直接以可玩状态开局。
    await this.bindEvents();
    this.bindPresence();
    window.addEventListener("beforeunload", () => this.destroy());
  }

  // ---------------------------------------------------------------- shell

  private buildShell(): void {
    clear(this.root);
    this.root.classList.add("overlay-root");
    if (this.view.mock) {
      // 演示窗保留自己的渐变背景；真实模式保持透明，真桌面从卡牌间隙透出。
      this.root.style.backgroundImage =
        "linear-gradient(140deg, #1b1f27 0%, #23222a 45%, #2b2419 100%)";
    }

    this.board = h("div", "board");
    this.board.setAttribute("role", "group");
    this.board.setAttribute("aria-label", t(this.lang, "overlay.boardAria"));
    this.root.appendChild(this.board);

    this.toastElement = h("div", "toast");
    this.toastElement.setAttribute("role", "status");
    this.toastElement.setAttribute("aria-live", "polite");
    this.toastElement.hidden = true;
    this.root.appendChild(this.toastElement);

    this.resultLayer = h("div", "modal-layer");
    this.resultLayer.hidden = true;
    this.root.appendChild(this.resultLayer);

    this.exitLayer = h("div", "modal-layer");
    this.exitLayer.hidden = true;
    this.root.appendChild(this.exitLayer);
  }

  private buildHud(): void {
    this.hudWrap = h("div", "hud-wrap");
    const hud = h("div", "hud");

    const progress = h("div", "hud-progress");
    this.hudProgressText = h("span", "hud-progress-text", "0 / 0");
    progress.appendChild(this.hudProgressText);
    const track = h("span", "hud-progress-track");
    this.hudProgressFill = h("span", "hud-progress-fill");
    track.appendChild(this.hudProgressFill);
    progress.appendChild(track);
    hud.appendChild(progress);

    const time = h("div", "hud-stat");
    time.appendChild(iconEl("clock", 12));
    this.hudTime = h("span", "hud-value", "00:00");
    time.appendChild(this.hudTime);
    time.title = t(this.lang, "overlay.timeLabel");
    hud.appendChild(time);

    const moves = h("div", "hud-stat");
    moves.appendChild(iconEl("move", 12));
    this.hudMoves = h("span", "hud-value", "0");
    moves.appendChild(this.hudMoves);
    moves.title = tDynamic(this.lang, pluralKey("overlay.moves", 0), { n: 0 });
    hud.appendChild(moves);

    const mute = h("button", "hud-button");
    mute.type = "button";
    mute.appendChild(iconEl(this.state.muted ? "mute" : "volume", 12));
    const syncMute = () => {
      clear(mute);
      mute.appendChild(iconEl(this.state.muted ? "mute" : "volume", 12));
      mute.title = t(
        this.lang,
        this.state.muted ? "launcher.unmute" : "launcher.mute",
      );
      mute.setAttribute("aria-label", mute.title);
    };
    syncMute();
    mute.addEventListener("click", () => {
      const next = !this.state.muted;
      this.state.muted = next;
      this.sounds.setMuted(next);
      syncMute();
      void api.setMuted(next).catch((error) => {
        console.error("mute failed", asAppError(error));
        this.state.muted = !next;
        this.sounds.setMuted(!next);
        syncMute();
      });
    });
    hud.appendChild(mute);

    const exit = h("button", "hud-button");
    exit.type = "button";
    exit.appendChild(iconEl("close", 12));
    exit.title = t(this.lang, "overlay.exitButton");
    exit.setAttribute("aria-label", t(this.lang, "overlay.exitButton"));
    exit.addEventListener("click", () => this.showExitConfirm());
    hud.appendChild(exit);

    this.studyChip = h("button", "study-chip");
    this.studyChip.type = "button";
    this.studyChip.hidden = true;
    this.studyChip.appendChild(this.buildStudyRing());
    this.studySeconds = h("span", "study-seconds");
    this.studyChip.appendChild(this.studySeconds);
    this.studyChip.addEventListener("click", () => this.skipStudy());
    this.hudWrap.appendChild(this.studyChip);

    const row = h("div", "hud-row");
    row.appendChild(hud);
    this.hudWrap.appendChild(row);

    this.hudHint = h("div", "hud-hint");
    this.hudHint.hidden = true;
    this.hudWrap.appendChild(this.hudHint);

    this.root.appendChild(this.hudWrap);

    this.confirmButton = h("button", "confirm-button");
    this.confirmButton.type = "button";
    this.confirmButton.hidden = true;
    this.confirmButton.textContent = t(this.lang, "overlay.confirm");
    this.confirmButton.setAttribute("aria-label", t(this.lang, "overlay.confirmAria"));
    this.confirmButton.addEventListener("click", () => {
      if (this.pending) return;
      this.pending = true;
      this.confirmButton.disabled = true;
      void api
        .finishRound()
        .then(() => {
          this.pending = false;
          this.confirmButton.disabled = false;
        })
        .catch((error) => {
          this.pending = false;
          this.confirmButton.disabled = false;
          const payload = asAppError(error);
          console.error("finish failed", payload);
          this.toast(errorText(this.lang, payload.code));
          this.sounds.error();
        });
    });
    row.appendChild(this.confirmButton);
  }

  /** 倒计时圆环：pathLength=1 让 dashoffset 直接等于“剩余比例”的补数。 */
  private buildStudyRing(): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "study-ring");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    const track = document.createElementNS(ns, "circle");
    const fill = document.createElementNS(ns, "circle");
    for (const circle of [track, fill]) {
      circle.setAttribute("cx", "10");
      circle.setAttribute("cy", "10");
      circle.setAttribute("r", "8");
    }
    track.setAttribute("class", "study-ring-track");
    fill.setAttribute("class", "study-ring-fill");
    fill.setAttribute("pathLength", "1");
    // 从 12 点方向顺时针收缩；用属性旋转，避免和 CSS transition 抢 transform。
    fill.setAttribute("transform", "rotate(-90 10 10)");
    this.studyRingFill = fill;
    svg.appendChild(track);
    svg.appendChild(fill);
    return svg;
  }

  private buildBoard(): void {
    // 发牌级联：按 y→x 排序逐卡延迟入场，像发牌员摆牌；只作用于首建路径。
    // 游戏中途 applyState 调 ensureBack（重新盖回）时不带延迟——那是普通事件，
    // 卡背凭空"迟到"一拍反而像 bug。
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const slot of this.view.slots) this.ensureBack(slot);
      return;
    }
    const ordered = [...this.view.slots].sort((a, b) => a.y - b.y || a.x - b.x);
    ordered.forEach((slot, index) => {
      this.ensureBack(slot);
      const delay = Math.min(index * 16, 560);
      const inner = this.backs.get(slot.id)?.querySelector<HTMLElement>(".card-back-inner");
      if (inner) {
        inner.style.animation = `card-in 220ms var(--ease) ${delay}ms backwards`;
        // 入场动画播完立刻清掉内联声明：它优先级高于类规则，不清会永久
        // 压住后续的 .breathing / .revealing 动画。
        inner.addEventListener("animationend", () => {
          inner.style.animation = "";
        }, { once: true });
      }
      if (this.view.isPrimary) {
        this.dealTimers.push(
          window.setTimeout(() => this.sounds.dealTick(), delay + 200),
        );
      }
    });
  }

  // --------------------------------------------------------------- events

  private clockTimer: number | null = null;
  private unlisteners: Array<() => void> = [];
  private readonly onKeyDownBound = (event: KeyboardEvent) => this.onKeyDown(event);

  private async bindEvents(): Promise<void> {
    // 订阅失败必须让 init() 失败：否则覆盖窗会以“永远收不到 state-changed”
    // 的僵尸状态报告 ready，玩家看到一副永远翻不开的牌且没有任何提示。
    const unlisten = await listen<PublicState>("state-changed", (event) => {
      this.applyState(event.payload, false);
    });
    this.unlisteners.push(unlisten);
    // drag-hover 由本窗口本地 applyHover 已足够；后端广播在多显示器下会与
    // 本地状态交错，这里不再订阅，避免 outline 闪烁。
    document.addEventListener("keydown", this.onKeyDownBound);
    // 计时器只在状态事件里刷新会冻结：加 1 秒心跳。
    this.clockTimer = window.setInterval(() => this.updateClock(), 1000);
  }

  private bindPresence(): void {
    this.presence = new PresenceController({ onIdle: () => this.breathe() });
    // 任何指针操作都重置空闲计时。
    this.board.addEventListener("pointerdown", () => this.presence?.resetIdle());
  }

  private breathe(): void {
    if (this.reducedMotion.matches) return;
    for (const back of this.backs.values()) back.classList.remove("breathing");
    // 一次回流足够重播全部动画；逐卡 offsetWidth 会让 100+ 张牌同步重排。
    void this.board.offsetWidth;
    for (const back of this.backs.values()) {
      back.classList.add("breathing");
      back.addEventListener(
        "animationend",
        () => back.classList.remove("breathing"),
        { once: true },
      );
    }
  }

  /** 按 y/x 排序取牌桌全部卡片（结算时多数槽位已是正面，不能只取 backs），
   *  交给编排器演多米诺；动画期间不发任何游戏命令。 */
  private runExit(then: () => void): void {
    // 记忆阶段的预览卡不属于正式牌桌：先收掉，否则会混进退出演出。
    this.endStudy();
    // 退出演出开始前收掉选中金框与提示：正面卡等下会翻走，
    // 留在 .card 上的选中框会变成一圈没有内容的空框。
    this.clearSelection();
    const order = new Map<number, number>();
    [...this.view.slots]
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .forEach((slot, index) => order.set(slot.id, index));
    const cards = [...this.board.querySelectorAll<HTMLElement>(".card")].sort(
      (a, b) => (order.get(Number(a.dataset.slot)) ?? 0) - (order.get(Number(b.dataset.slot)) ?? 0),
    );
    this.choreography = new ExitChoreography(cards);
    this.choreography.play(then);
  }

  /** 动画中用户反悔：移除类、pending 归位，then 不会执行。 */
  private cancelExit(): void {
    this.choreography?.cancel();
    this.choreography = null;
    this.pending = false;
    // 退出演出已把记忆阶段预览收掉了；若正式起点还没到，恢复预览，
    // 否则玩家会在“没看过布局”的情况下直接开局。
    this.syncStudy();
  }

  /** 覆盖窗关闭/重建时释放定时器与事件监听，避免多局叠加。 */
  destroy(): void {
    this.endStudy();
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    for (const timer of this.dealTimers) window.clearTimeout(timer);
    this.dealTimers = [];
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    document.removeEventListener("keydown", this.onKeyDownBound);
    this.unbindDragListeners();
    this.drag = null;
    this.presence?.dispose();
    this.presence = null;
    this.choreography?.cancel();
    this.choreography = null;
  }

  private onKeyDown(event: KeyboardEvent): void {
    // 动画期间 pending 为真，但 Esc 仍要能取消演出（spec 硬边界 #3）。
    // 不能无条件 return，否则 cancel 在真实交互里永远不可达。
    if (this.pending) {
      if (event.key === "Escape" && this.choreography) {
        event.preventDefault();
        this.cancelExit();
      }
      return;
    }
    if (event.key === "Tab" && (this.resultOpen || this.exitOpen)) {
      const container = this.resultOpen ? this.resultLayer : this.exitLayer;
      this.trapFocus(container, event);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // 退出确认优先于结算：超时结算恰好压在退出确认上时，Esc 仍能关掉它。
      if (this.exitOpen) {
        this.hideExitConfirm();
        return;
      }
      if (this.resultOpen) {
        // 结算弹窗必须由用户明确选择，Esc 不叠加退出确认。
        return;
      }
      // 选中卡不再挡住退出确认：Esc 只负责退出，取消选中仍靠再点一次该卡。
      this.showExitConfirm();
      return;
    }
  }

  private trapFocus(container: HTMLElement, event: KeyboardEvent): void {
    const focusable = container.querySelectorAll<HTMLElement>("button, [href], input, [tabindex]:not([tabindex='-1'])");
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ---------------------------------------------------------------- state

  private applyState(state: PublicState, initial: boolean): void {
    if (state.finished) this.pending = false;
    if (!state.finished && this.resultOpen) {
      // 另一块屏先开了新局：本窗还在演的保存/恢复必须立刻取消，
      // 否则 1s 后 then() 会把旧局命令打到新局上，静默失败。
      if (this.pending && this.choreography) this.cancelExit();
      else this.pending = false;
    }
    const previousFinished = this.state.finished;
    const previouslyPlaced = new Set(
      this.state.placements.filter((id): id is number => id !== null && id !== undefined),
    );
    this.state = state;
    this.sounds.setMuted(state.muted);
    // 翻下时长由后端给出：预览卡的 CSS 过渡与本地收尾定时器读同一个值。
    this.root.style.setProperty("--flip-ms", `${state.flipMs || 320}ms`);
    // 结算时收起还没落位的选中金框：弹窗后面留一圈空金边既误导也难看。
    if (state.finished) this.clearSelection();

    const iconSlot = new Map<number, number>();
    state.placements.forEach((icon, slot) => {
      if (icon !== null && icon !== undefined) iconSlot.set(icon, slot);
    });

    // 翻牌音与卡面创建的同一帧触发：drawCard 的 Promise 比 state-changed 晚，
    // 在那里播会导致声音落后于画面。只有「新出现」的正面才响，拖动换位不响。
    let newFace = false;
    for (const icon of this.view.icons) {
      const slotId = iconSlot.get(icon.id);
      if (slotId === undefined) {
        this.dropFace(icon.id);
        continue;
      }
      // 用前后 placements 判断“新抽出”，与本地窗口是否持有这张卡无关：
      // 否则副屏抽牌时主屏 newFace=false，整副牌在副屏上全程无翻牌音。
      if (!previouslyPlaced.has(icon.id)) newFace = true;
      if (!this.slots.has(slotId)) {
        this.dropFace(icon.id);
        continue;
      }
      this.ensureFace(icon, this.slots.get(slotId)!, slotId);
    }
    if (!initial && newFace && this.view.isPrimary) this.sounds.flip();

    for (const slot of this.view.slots) {
      const placed = state.placements[slot.id];
      if (placed === null || placed === undefined) {
        this.ensureBack(slot);
      } else {
        this.dropBack(slot.id);
      }
    }

    if (this.selectedIcon !== null) {
      // 选中态跟随图标的新槽位：换位（自己被拖走/别卡换进来）后，
      // 旧 selectedSlot 已过期，再点第三张卡会用它发起错误交换。
      // 图标被换到别的显示器时本屏已没有它的卡，必须清选中，否则下一次
      // 点击会用远端槽位发起一次玩家看不到来源的交换。
      const current = iconSlot.get(this.selectedIcon);
      if (current === undefined || !this.slots.has(current)) {
        this.clearSelection();
      } else if (current !== this.selectedSlot) {
        this.selectedSlot = current;
      }
    }

    this.syncStudy();
    this.updateHud();
    this.updateConfirmButton();

    if (state.finished && state.result) {
      if (!previousFinished || initial) this.showResult(state.result);
    } else if (this.resultOpen) {
      this.hideResult();
    }
  }

  private updateHud(): void {
    const total = this.view.total;
    const revealed = total - this.state.remaining;
    this.hudProgressText.textContent = `${revealed} / ${total}`;
    this.hudProgressText.title = t(this.lang, "overlay.progress", {
      revealed,
      total,
    });
    const percent = total > 0 ? (revealed / total) * 100 : 0;
    this.hudProgressFill.style.transform = `scaleX(${percent / 100})`;
    this.hudMoves.textContent = String(this.state.moves);
    this.hudMoves.title = tDynamic(
      this.lang,
      pluralKey("overlay.moves", this.state.moves),
      { n: this.state.moves },
    );
    this.updateClock();
    this.placeFloating();
  }

  private updateClock(): void {
    if (!this.hudTime) return;
    const elapsed = this.state.finished && this.state.result
      ? this.state.result.elapsedMs
      : this.state.startedAtMs > 0
        ? Math.max(0, Date.now() - this.state.startedAtMs)
        : 0;
    // 限时模式：以所有窗口共享的后端 startedAtMs 为锚，多屏倒计时才不会
    // 各走各的；重开时后端刷新 startedAtMs，TimedClock 随之重置。
    const limit = this.state.limitMs;
    const timed = limit > 0 && !this.state.finished;
    const tick = this.clock.tick(limit, this.state.startedAtMs, !timed);
    if (timed) {
      this.hudTime.title = t(this.lang, "overlay.timeLeftLabel");
      if (tick.leftMs === 0) {
        this.hudTime.textContent = t(this.lang, "hud.timeUp");
      } else {
        this.hudTime.textContent = t(this.lang, "hud.timeLeft", {
          time: formatDuration(tick.leftMs),
        });
      }
      this.hudTime.classList.toggle("time-low", tick.leftMs <= limit * 0.2);
      if (tick.expired) {
        void api.finishRound(true).catch((error: unknown) => {
          const payload = asAppError(error);
          console.error("timeout finish failed", payload);
          // 到点结算失败必须可见；否则 HUD 停在“时间到”，玩家却还能继续操作。
          this.toast(errorText(this.lang, payload.code));
        });
      }
      return;
    }
    this.hudTime.classList.remove("time-low");
    this.hudTime.title = t(this.lang, "overlay.timeLabel");
    this.hudTime.textContent = formatDuration(elapsed);
  }

  private updateConfirmButton(): void {
    const ready = this.state.remaining === 0 && !this.state.finished;
    const appeared = ready && this.confirmButton.hidden;
    const disappeared = !ready && !this.confirmButton.hidden;
    this.confirmButton.hidden = !ready;
    if (appeared) {
      // CSS 动画只在元素创建时跑一次；hidden→显示必须重播，否则用户看不到弹出。
      this.confirmButton.style.animation = "none";
      void this.confirmButton.offsetWidth;
      this.confirmButton.style.animation = "";
    }
    // 按钮显隐会改变 HUD 行宽；宽度变了要重新选位，否则胶囊会偏左/偏右。
    if (appeared || disappeared) this.placeFloating();
  }

  // ---------------------------------------------------------------- study

  /** 后端把正式起点放在未来 = 记忆阶段；所有窗口按同一锚点算圆环。 */
  private syncStudy(): void {
    if (this.state.finished) {
      this.endStudy();
      return;
    }
    const tick = studyTick(
      this.state.startedAtMs,
      this.state.studyMs,
      this.state.flipMs,
    );
    if (!tick.done) {
      // 退出演出期间不要往动画上重铺预览；取消时 cancelExit 会再同步一次。
      if (this.pending) return;
      if (!this.studyActive) {
        this.startStudy();
      } else if (this.studyAnchor !== this.state.startedAtMs) {
        // 跳过只把同一阶段提前：换锚点并重新排期，不重放预览。
        this.studyAnchor = this.state.startedAtMs;
        this.scheduleStudy();
      }
      return;
    }
    // 阶段已过：本窗加载晚了就不再补演；自然翻下则等过渡定时器收尾。
    if (this.studyActive && !this.studyFlipping) this.endStudy();
  }

  private startStudy(): void {
    this.endStudy();
    this.studyActive = true;
    this.studyAnchor = this.state.startedAtMs;
    // 预览期间整块牌桌不可交互（含键盘焦点），HUD 与跳过按钮不受影响。
    this.board.inert = true;
    this.clearSelection();
    this.hudHint.hidden = true;
    for (const slot of this.view.slots) {
      // 槽位 id 就是该位置原本的图标 id：预览即真实布局。
      const icon = this.icons.get(slot.id);
      if (!icon) continue;
      const preview = h("div", "card card-face card-preview");
      preview.setAttribute("aria-hidden", "true");
      const inner = this.buildFaceInner(icon);
      inner.classList.add("is-preview");
      preview.appendChild(inner);
      this.placeCard(preview, slot);
      this.board.appendChild(preview);
      this.previews.push(preview);
    }
    // 发牌级联被预览盖住，声音却还在响；记忆阶段开始时收掉这些 tick。
    for (const timer of this.dealTimers) window.clearTimeout(timer);
    this.dealTimers = [];
    this.studyChip.hidden = false;
    this.studyChip.disabled = false;
    this.studySkipPending = false;
    this.studyShownSeconds = -1;
    this.updateStudy();
    this.scheduleStudy();
    this.studyTimer = window.setInterval(() => this.updateStudy(), 100);
    this.placeFloating();
  }

  /** 起翻由正式锚点反推的一次性定时器排期；跳过换锚点后重新调用。 */
  private scheduleStudy(): void {
    if (!this.studyActive || this.studyFlipping) return;
    if (this.studyFlipTimer !== null) {
      window.clearTimeout(this.studyFlipTimer);
      this.studyFlipTimer = null;
    }
    const tick = studyTick(
      this.state.startedAtMs,
      this.state.studyMs,
      this.state.flipMs,
    );
    if (tick.done) {
      this.endStudy();
      return;
    }
    this.studyFlipTimer = window.setTimeout(
      () => this.beginFlipDown(),
      tick.flipDelayMs,
    );
  }

  private updateStudy(): void {
    if (!this.studyActive || this.studyFlipping) return;
    const tick = studyTick(
      this.state.startedAtMs,
      this.state.studyMs,
      this.state.flipMs,
    );
    this.studyRingFill.style.strokeDashoffset = String(1 - tick.fraction);
    if (tick.seconds !== this.studyShownSeconds) {
      this.studyShownSeconds = tick.seconds;
      this.studySeconds.textContent = t(this.lang, "overlay.study", {
        seconds: tick.seconds,
      });
      this.studyChip.setAttribute(
        "aria-label",
        t(this.lang, "overlay.studyAria", { seconds: tick.seconds }),
      );
      this.studyChip.title = t(this.lang, "overlay.studySkip");
    }
    if (tick.done) {
      // 定时器被系统节流或丢失时的兜底；正常路径由 settle 定时器收尾。
      this.endStudy();
      return;
    }
    // 一次性排期若被延迟到翻下窗口内，心跳补一次起翻。
    if (tick.flipDelayMs === 0) this.beginFlipDown();
  }

  private beginFlipDown(): void {
    if (this.studyFlipping) return;
    this.studyFlipping = true;
    if (this.studyTimer !== null) {
      window.clearInterval(this.studyTimer);
      this.studyTimer = null;
    }
    if (this.studyFlipTimer !== null) {
      window.clearTimeout(this.studyFlipTimer);
      this.studyFlipTimer = null;
    }
    this.studyChip.disabled = true;
    for (const preview of this.previews) preview.classList.add("is-flipping");
    if (this.view.isPrimary) this.sounds.flip();
    // 预览必须在正式起点移除；如果起翻被延迟，宁可在锚点切掉最后一小段
    // 过渡，也不把布局多亮给玩家。
    const tick = studyTick(
      this.state.startedAtMs,
      this.state.studyMs,
      this.state.flipMs,
    );
    this.studyFlipTimer = window.setTimeout(
      () => this.endStudy(),
      Math.max(0, tick.settleDelayMs),
    );
  }

  /** 收尾：移除预览、解锁牌桌、收掉圆环。可重入。 */
  private endStudy(): void {
    if (this.studyTimer !== null) {
      window.clearInterval(this.studyTimer);
      this.studyTimer = null;
    }
    if (this.studyFlipTimer !== null) {
      window.clearTimeout(this.studyFlipTimer);
      this.studyFlipTimer = null;
    }
    for (const preview of this.previews) preview.remove();
    this.previews = [];
    this.studyActive = false;
    this.studyFlipping = false;
    this.studyAnchor = 0;
    this.studySkipPending = false;
    this.studyShownSeconds = -1;
    this.board.inert = false;
    if (this.studyChip) {
      this.studyChip.hidden = true;
      this.studyChip.disabled = false;
    }
    this.placeFloating();
  }

  private skipStudy(): void {
    if (!this.studyActive || this.studyFlipping || this.studySkipPending) return;
    this.studySkipPending = true;
    this.studyChip.disabled = true;
    void api.skipStudy().catch((error) => {
      this.studySkipPending = false;
      this.studyChip.disabled = false;
      const payload = asAppError(error);
      console.error("skip study failed", payload);
      this.toast(errorText(this.lang, payload.code));
      this.sounds.error();
    });
  }

  // ---------------------------------------------------------------- cards

  private ensureBack(slot: SlotView): void {
    let element = this.backs.get(slot.id);
    if (!element) {
      element = h("button", "card card-back");
      element.type = "button";
      element.dataset.slot = String(slot.id);
      element.dataset.tone = slot.tone;
      const inner = h("span", "card-inner card-back-inner");
      inner.appendChild(h("span", "card-back-mark", "?"));
      element.appendChild(inner);
      element.setAttribute("aria-label", t(this.lang, "overlay.cardBackAria"));
      element.addEventListener("click", () => this.onBackClick(slot.id));
      inner.style.animation = "card-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
      inner.addEventListener("animationend", () => {
        inner.style.animation = "";
      }, { once: true });
      this.board.appendChild(element);
      this.backs.set(slot.id, element);
    }
    this.placeCard(element, slot);
  }

  private dropBack(slotId: number): void {
    const element = this.backs.get(slotId);
    if (!element) return;
    this.backs.delete(slotId);
    element.remove();
  }

  private ensureFace(icon: IconView, slot: SlotView, slotId: number): void {
    let element = this.faces.get(icon.id);
    if (!element) {
      element = h("button", "card card-face");
      element.type = "button";
      element.dataset.icon = String(icon.id);
      element.dataset.slot = String(slotId);
      element.appendChild(this.buildFaceInner(icon));
      element.setAttribute("aria-label", t(this.lang, "overlay.cardFaceAria", { name: icon.name }));
      // 槽位必须每次从 dataset 现读：卡牌移动后被复用，闭包里的 slot 会过期。
      element.addEventListener("click", () => {
        const slotId = Number(element!.dataset.slot);
        if (Number.isFinite(slotId)) this.onFaceClick(icon.id, slotId);
      });
      element.addEventListener("pointerdown", (event) => {
        const current = this.slots.get(Number(element!.dataset.slot));
        if (current) this.onPointerDown(event, icon.id, current, element!);
      });
      // 翻牌 3D 动画由 CSS 在元素创建时自动播放；拖动换位复用元素时不重播。
      this.board.appendChild(element);
      this.faces.set(icon.id, element);
    } else {
      element.dataset.slot = String(slotId);
    }
    this.placeCard(element, slot);
  }

  /** 正式卡面与记忆阶段预览共用同一套内容，保证预览与翻牌后 1:1。 */
  private buildFaceInner(icon: IconView): HTMLElement {
    const inner = h("span", "card-inner card-face-inner");
    if (icon.image) {
      // 透明卡面：全格画布已把图标摆回格内原位，名字按桌面标签排版，
      // 于是翻转后的样子与真实桌面 1:1（尺寸/颜色/位置/字体）。
      inner.classList.add("is-photo");
      const image = h("img", "face-image");
      image.src = icon.image;
      image.alt = "";
      inner.appendChild(image);
      inner.appendChild(this.buildFaceName(icon));
    } else {
      // 无图（演示模式或抠图失败）：退回实体卡面 + 字母占位。
      const iconBox = h("span", "card-icon");
      iconBox.appendChild(
        h("span", "card-icon-letter", Array.from(icon.name || "?")[0] ?? "?"),
      );
      inner.appendChild(iconBox);
      inner.appendChild(h("span", "card-name", icon.name));
    }
    return inner;
  }

  private dropFace(iconId: number): void {
    const element = this.faces.get(iconId);
    if (!element) return;
    this.faces.delete(iconId);
    element.remove();
  }

  /** 桌面标签样式的名字：字体/字号/颜色/位置都取真实桌面参数。 */
  private buildFaceName(icon: IconView): HTMLElement {
    const element = h("span", "face-name", icon.name);
    const font = this.view.labelFont;
    element.style.fontFamily = `"${font.family}", var(--font)`;
    element.style.fontSize = `${font.sizePx}px`;
    element.style.fontWeight = String(font.weight);
    if (icon.label) {
      element.style.top = `${icon.label.top}px`;
      element.style.left = `${icon.label.centerX}px`;
      // Explorer 的标签宽度可能大于格宽（长名字允许溢出到相邻格）。
      element.style.width = `${icon.label.width}px`;
    }
    return element;
  }

  private placeCard(element: HTMLElement, slot: SlotView): void {
    element.style.width = `${slot.w}px`;
    element.style.height = `${slot.h}px`;
    element.style.transform = `translate3d(${slot.x}px, ${slot.y}px, 0)`;
  }

  // --------------------------------------------------------------- input

  private onBackClick(slotId: number): void {
    if (this.state.finished || this.pending || this.suppressClick) return;
    if (this.selectedIcon !== null) {
      this.dropInto(slotId);
      return;
    }
    const element = this.backs.get(slotId);
    void api.drawCard(slotId).catch((error) => {
      const payload = asAppError(error);
      console.error("draw failed", payload);
      this.toast(errorText(this.lang, payload.code));
      this.sounds.error();
      if (element) this.shake(element);
    });
  }

  private onFaceClick(iconId: number, slotId: number): void {
    if (this.state.finished || this.pending || this.suppressClick) return;
    if (this.selectedIcon !== null && this.selectedIcon !== iconId) {
      // 只设置落点：selectedSlot 必须保留“被选中那张牌”的槽位，
      // 否则 from === to，交换会被当成原地点击而静默取消。
      this.targetSlot = slotId;
      this.commitSelection();
      return;
    }
    if (this.selectedIcon === iconId) {
      this.clearSelection();
      return;
    }
    this.selectIcon(iconId, slotId);
  }

  private onPointerDown(
    event: PointerEvent,
    iconId: number,
    slot: SlotView,
    element: HTMLButtonElement,
  ): void {
    if (this.state.finished || this.pending) return;
    if (this.drag) return;
    if (event.button !== 0) return;
    event.preventDefault();
    // 新手势开始即解除 click 抑制：旧手势的 click 在 pointerup 后立刻派发，
    // 不会迟于人类的下一次按下；比纯时间窗更稳（不依赖 200ms 够不够）。
    this.suppressClick = false;
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败也不能让拖动卡死：window 级监听仍会收到 pointerup。
    }
    this.drag = {
      iconId,
      fromSlot: slot.id,
      element,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      slotX: slot.x,
      slotY: slot.y,
      armed: false,
      hoverSlot: null,
      lastClientX: event.clientX,
      tilt: 0,
    };
    this.bindDragListeners();
  }

  /**
   * 拖动监听挂在 window 上（捕获阶段）：指针捕获丢失、指针移出窗口、
   * 窗口失焦时都能收到 pointerup/pointercancel，卡片绝不会卡在半空。
   */
  private bindDragListeners(): void {
    if (this.dragListeners) return;
    const move = (event: Event) => this.onPointerMove(event as PointerEvent);
    const end = (event: Event) => this.finishDrag(event as PointerEvent);
    const cancel = () => this.finishDrag(null);
    this.dragListeners = { move, end, cancel };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("lostpointercapture", cancel, true);
  }

  private unbindDragListeners(): void {
    const listeners = this.dragListeners;
    if (!listeners) return;
    this.dragListeners = null;
    window.removeEventListener("pointermove", listeners.move, true);
    window.removeEventListener("pointerup", listeners.end, true);
    window.removeEventListener("pointercancel", listeners.cancel, true);
    window.removeEventListener("blur", listeners.cancel);
    window.removeEventListener("lostpointercapture", listeners.cancel, true);
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.armed) {
      if (Math.hypot(dx, dy) < 4) return;
      drag.armed = true;
      drag.element.classList.add("is-dragging");
      this.sounds.pickup();
    }
    event.preventDefault();
    drag.element.style.transition = "none";
    // 速度平滑出的微倾斜（±3°）：纸牌被拖动时随速度轻微甩尾；
    // reduced-motion 用户保持纯平移。
    const rawTilt = Math.max(-3, Math.min(3, (event.clientX - drag.lastClientX) * 0.6));
    drag.tilt = drag.tilt * 0.8 + rawTilt * 0.2;
    const tilt = this.reducedMotion.matches ? 0 : drag.tilt;
    drag.element.style.transform =
      `translate3d(${drag.slotX + dx}px, ${drag.slotY + dy}px, 0) rotate(${tilt.toFixed(2)}deg)`;

    const point = this.globalPoint(event.clientX, event.clientY);
    const target = this.hitTest(point.x, point.y, event.clientX, event.clientY);
    if (target !== drag.hoverSlot) {
      drag.hoverSlot = target;
      this.applyHover(target);
    }
    // 下一帧的“速度”要用本帧位置做差；不更新的话倾斜会锁死在 ±3°。
    drag.lastClientX = event.clientX;
  }

  private finishDrag(event: PointerEvent | null): void {
    const drag = this.drag;
    this.unbindDragListeners();
    if (!drag) return;
    this.drag = null;
    drag.element.classList.remove("is-dragging");
    drag.element.style.transition = "";
    // 悬停高亮是玩家对落点的唯一预期：松手先清掉残留金框。
    this.applyHover(null);
    try {
      drag.element.releasePointerCapture(drag.pointerId);
    } catch {
      // 已经释放或从未捕获，忽略。
    }

    const back = `translate3d(${drag.slotX}px, ${drag.slotY}px, 0)`;
    // 只是点击（没拖动）：立刻归位，把选中/交换交给 click 事件。
    if (!drag.armed) {
      drag.element.style.transform = back;
      return;
    }
    // armed 拖拽刚结束：浏览器还会派发一次 click。不抑制的话，click 会
    // 再走 onFaceClick → commitSelection，把第三张卡卷进同一次手势。
    this.suppressClick = true;
    // 200ms 后恢复。不要在这里提前清掉：浏览器在 pointerup 之后仍会派发
    // 一次 click，提前清标志会让“拖出去再拖回原位/空白”变成一次选中，
    // 已有选中时甚至会静默交换两张牌。
    window.setTimeout(() => {
      this.suppressClick = false;
    }, 200);
    // 拖拽途中本局结束或进入退出演出：只归位，不发游戏命令。
    if (this.state.finished || this.pending) {
      drag.element.style.transform = back;
      return;
    }
    // 中断（失焦/捕获丢失）或落在空白/原处：弹回原位，绝不悬停。
    // 落点与悬停高亮同源：玩家看到哪格高亮，松手就换哪格。重新 hitTest
    // 用的是松手瞬间的新坐标，边界上高亮 B、落点却变成 C，看起来就像
    // 一次拖拽同时改了三张卡。
    const target = event ? drag.hoverSlot : null;
    if (target === null || target === drag.fromSlot) {
      drag.element.style.transform = back;
      return;
    }
    const targetSlot = this.slots.get(target);
    if (targetSlot) {
      drag.element.style.transform = `translate3d(${targetSlot.x}px, ${targetSlot.y}px, 0)`;
    }
    this.sounds.drop();
    this.settle(drag.element);
    void api.moveCard(drag.fromSlot, target).catch((error) => {
      const payload = asAppError(error);
      console.error("move failed", payload);
      this.toast(errorText(this.lang, payload.code));
      this.sounds.error();
      drag.element.style.transform = back;
      this.shake(drag.element);
    });
  }

  private globalPoint(clientX: number, clientY: number): { x: number; y: number } {
    const scale = this.view.monitor.scale || 1;
    return {
      x: Math.round(this.view.monitor.x + clientX * scale),
      y: Math.round(this.view.monitor.y + clientY * scale),
    };
  }

  private hitTest(
    globalX: number,
    globalY: number,
    clientX?: number,
    clientY?: number,
  ): number | null {
    // HUD/确认按钮在卡牌之上；拖到它们上面松手不能落到被挡住的卡。
    if (clientX !== undefined && clientY !== undefined) {
      const rect = this.hudWrap.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX < rect.right &&
        clientY >= rect.top &&
        clientY < rect.bottom
      ) {
        return null;
      }
    }
    let best: { id: number; distance: number } | null = null;
    for (const slot of this.view.globalSlots) {
      const inside =
        globalX >= slot.screenX &&
        globalX < slot.screenX + slot.screenW &&
        globalY >= slot.screenY &&
        globalY < slot.screenY + slot.screenH;
      if (!inside) continue;
      const cx = slot.screenX + slot.screenW / 2;
      const cy = slot.screenY + slot.screenH / 2;
      const distance = Math.abs(globalX - cx) + Math.abs(globalY - cy);
      if (!best || distance < best.distance) best = { id: slot.id, distance };
    }
    return best ? best.id : null;
  }

  private applyHover(slotId: number | null): void {
    this.board.querySelectorAll(".is-drop-target").forEach((element) => {
      element.classList.remove("is-drop-target");
    });
    if (slotId === null) return;
    const element = this.elementForSlot(slotId);
    if (element) element.classList.add("is-drop-target");
  }

  private elementForSlot(slotId: number): HTMLElement | null {
    const face = Array.from(this.faces.values()).find(
      (element) => element.dataset.slot === String(slotId),
    );
    if (face) return face;
    return this.backs.get(slotId) ?? null;
  }

  // ------------------------------------------------------- keyboard move

  private selectIcon(iconId: number, slotId: number): void {
    this.clearSelection();
    this.selectedIcon = iconId;
    this.selectedSlot = slotId;
    this.targetSlot = slotId;
    const element = this.faces.get(iconId);
    if (element) {
      element.classList.add("is-selected");
      // 保留 DOM 焦点：覆盖窗是 focusable(false)，pointerdown 又
      // preventDefault 掉了默认聚焦；没有焦点，Esc 连退出确认/关闭弹窗
      // 都收不到。卡片不画焦点环（见 styles.css），不会与 .is-selected 叠圈。
      element.focus({ preventScroll: true });
    }
    this.hudHint.hidden = false;
    this.hudHint.textContent = t(this.lang, "overlay.selected");
    this.placeFloating();
  }

  private clearSelection(): void {
    if (this.selectedIcon !== null) {
      const element = this.faces.get(this.selectedIcon);
      if (element) {
        element.classList.remove("is-selected");
        // 不 blur：焦点是覆盖窗继续收到 Esc（退出确认/关闭弹窗）的来源，
        // 取消选中不应把键盘路径一起丢掉。
      }
    }
    this.selectedIcon = null;
    this.selectedSlot = null;
    this.targetSlot = null;
    this.hudHint.hidden = true;
    // 提示条隐藏后 HUD 行高变矮；不重新选位，胶囊会停在提示出现时的位置。
    this.placeFloating();
  }

  private commitSelection(): void {
    if (this.selectedIcon === null || this.targetSlot === null) return;
    const from = this.selectedSlot;
    const to = this.targetSlot;
    if (from === null || from === to) {
      this.clearSelection();
      return;
    }
    this.sounds.drop();
    const element = this.selectedIcon !== null ? this.faces.get(this.selectedIcon) : null;
    void api
      .moveCard(from, to)
      .catch((error) => {
        const payload = asAppError(error);
        console.error("move failed", payload);
        this.toast(errorText(this.lang, payload.code));
        this.sounds.error();
        if (element) this.shake(element);
      });
    this.clearSelection();
  }

  private dropInto(slotId: number): void {
    if (this.selectedIcon === null || this.selectedSlot === null) return;
    const from = this.selectedSlot;
    if (from === slotId) {
      this.clearSelection();
      return;
    }
    this.sounds.drop();
    const element = this.selectedIcon !== null ? this.faces.get(this.selectedIcon) : null;
    void api.moveCard(from, slotId).catch((error) => {
      const payload = asAppError(error);
      console.error("move failed", payload);
      this.toast(errorText(this.lang, payload.code));
      this.sounds.error();
      if (element) this.shake(element);
    });
    this.clearSelection();
  }

  // ------------------------------------------------------- reveal effects

  /**
   * 错误反馈：涉事卡左右抖动 400ms。必须用 WAAPI 叠加合成（composite:"add"）：
   * 替换式 CSS 动画会整体顶掉 animation 属性，face 的 rotateY(180→0) 基线
   * 靠翻转动画 forwards 撑住，被顶掉就隐身；叠加合成无此问题。
   */
  private shake(element: HTMLElement): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    element.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-4px)" },
        { transform: "translateX(4px)" },
        { transform: "translateX(-3px)" },
        { transform: "translateX(3px)" },
        { transform: "translateX(-1px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 400, easing: "ease-out", composite: "add" },
    );
  }

  /** 落卡受压回弹：120ms 轻压（scale 1→0.97→1），叠加合成，不碰位置 transform。 */
  private settle(element: HTMLElement): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    element.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(0.97)" },
        { transform: "scale(1)" },
      ],
      { duration: 120, easing: "ease-out", composite: "add" },
    );
  }

  private animateCountUp(element: HTMLElement, target: number): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.textContent = String(target);
      return;
    }
    const start = performance.now();
    const duration = 650;
    const tick = (now: number) => {
      if (!element.isConnected) return;
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = String(Math.round(target * eased));
      if (progress < 1) window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  }

  // --------------------------------------------------------------- modals

  private showResult(result: RoundResult): void {
    this.pending = false;
    this.resultOpen = true;
    clear(this.resultLayer);
    const panel = h("div", "modal");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const title = h("p", "modal-title", t(this.lang, "result.title"));
    title.id = "result-title";
    panel.setAttribute("aria-labelledby", title.id);
    panel.appendChild(title);
    if (result.timedOut) {
      panel.appendChild(h("p", "modal-timed-out", t(this.lang, "result.timedOut")));
    }
    const figure = h("div", "result-figure");
    figure.appendChild(h("span", "result-label", t(this.lang, "result.accuracy")));
    const number = h("span", "result-value");
    const digit = h("span", "result-number", "0");
    number.appendChild(digit);
    number.appendChild(h("span", "result-unit", "%"));
    figure.appendChild(number);
    figure.appendChild(
      h("span", "result-sub", t(this.lang, "result.correct", {
        correct: result.correct,
        total: result.total,
      })),
    );
    panel.appendChild(figure);
    // 只在主屏播放结算音，多显示器时避免和弦叠放。
    if (this.view.isPrimary) this.sounds.finish(result.accuracy);
    this.animateCountUp(digit, result.accuracy);

    const stats = h("div", "result-stats");
    const timeStat = h("span", "result-stat");
    timeStat.appendChild(iconEl("clock", 13));
    timeStat.appendChild(
      h("span", "", t(this.lang, "result.time", { time: formatDuration(result.elapsedMs) })),
    );
    stats.appendChild(timeStat);
    const moveStat = h("span", "result-stat");
    moveStat.appendChild(iconEl("move", 13));
    moveStat.appendChild(
      h("span", "", tDynamic(this.lang, pluralKey("result.moves", result.moves), { n: result.moves })),
    );
    stats.appendChild(moveStat);
    panel.appendChild(stats);

    const actions = h("div", "modal-actions");
    const replay = h("button", "primary-button");
    replay.type = "button";
    replay.appendChild(iconEl("play", 14));
    replay.appendChild(h("span", "", t(this.lang, "result.playAgain")));
    replay.addEventListener("click", () => {
      if (this.pending) return;
      this.pending = true;
      void api
        .replayRound()
        .then(() => {
          this.pending = false;
        })
        .catch((error) => {
          this.pending = false;
          const payload = asAppError(error);
          console.error("replay failed", payload);
          this.toast(errorText(this.lang, payload.code));
          this.sounds.error();
        });
    });
    actions.appendChild(replay);

    if (this.view.mock) {
      const quit = h("button", "secondary-button");
      quit.type = "button";
      quit.appendChild(h("span", "", t(this.lang, "result.quitDemo")));
      quit.addEventListener("click", () => {
        if (this.pending) return;
        this.pending = true;
        void api.quitApp();
      });
      actions.appendChild(quit);
      panel.appendChild(actions);
      panel.appendChild(h("p", "modal-note", t(this.lang, "result.demoNote")));
    } else {
      // 超时结算允许空槽位，但写回要求每个槽位都有图标：空槽时保存是死路。
      const canSave = this.state.placements.every(
        (placed) => placed !== null && placed !== undefined,
      );
      const save = h("button", "secondary-button");
      save.type = "button";
      save.appendChild(h("span", "", t(this.lang, "result.save")));
      save.addEventListener("click", () => {
        if (this.pending) return;
        this.pending = true;
        this.runExit(() => {
          this.showBusy(panel, t(this.lang, "result.applying"));
          void api
            .saveAndExit()
            .catch((error) => {
              this.pending = false;
              const payload = asAppError(error);
              console.error("save failed", payload);
              // 另一块屏在演出期间开了新局时，本窗结算面板可能已被移除；
              // 往脱离文档的 panel 里写错误 UI，用户永远看不到。
              if (!panel.isConnected) return;
              this.showBusy(panel, errorText(this.lang, payload.code), true);
            });
        });
      });
      if (canSave) actions.appendChild(save);

      const restore = h("button", "text-button");
      restore.type = "button";
      restore.appendChild(h("span", "", t(this.lang, "result.restore")));
      restore.addEventListener("click", () => {
        if (this.pending) return;
        this.pending = true;
        this.runExit(() => {
          this.showBusy(panel, t(this.lang, "result.restoring"));
          void api
            .restoreAndExit()
            .catch((error) => {
              this.pending = false;
              const payload = asAppError(error);
              console.error("restore failed", payload);
              if (!panel.isConnected) return;
              this.showBusy(panel, errorText(this.lang, payload.code), true);
            });
        });
      });
      actions.appendChild(restore);
      panel.appendChild(actions);
      panel.appendChild(
        h(
          "p",
          "modal-note",
          t(this.lang, canSave ? "result.saveNote" : "result.incompleteNote"),
        ),
      );
    }

    // 复制结果：demo 与真实模式都提供；分享行走 i18n 模板，moves 用复数机制。
    const copy = h("button", "text-button");
    copy.type = "button";
    copy.appendChild(h("span", "", t(this.lang, "result.copy")));
    copy.addEventListener("click", () => {
      const line = t(this.lang, "result.shareLine", {
        total: result.total,
        accuracy: result.accuracy,
        time: formatDuration(result.elapsedMs),
        moves: tDynamic(this.lang, pluralKey("result.moves", result.moves), { n: result.moves }),
      });
      this.copyText(line);
    });
    actions.appendChild(copy);

    this.resultLayer.appendChild(panel);
    this.resultLayer.hidden = false;
    const focusTarget = panel.querySelector<HTMLElement>("button");
    focusTarget?.focus({ preventScroll: true });
  }

  /** 剪贴板 API 可能不存在（受限上下文）也可能拒绝；两条路都要能复制。 */
  private copyText(line: string): void {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        void navigator.clipboard
          .writeText(line)
          .then(() => this.toast(t(this.lang, "result.copied")))
          .catch(() => this.copyFallback(line));
        return;
      }
    } catch {
      // 属性访问被拒时直接走兜底。
    }
    this.copyFallback(line);
  }

  private copyFallback(line: string): void {
    const area = document.createElement("textarea");
    area.value = line;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    this.toast(t(this.lang, ok ? "result.copied" : "result.copyFailed"));
  }

  private showBusy(panel: HTMLElement, message: string, failed = false): void {
    const actions = panel.querySelector(".modal-actions");
    if (actions) actions.remove();
    const note = panel.querySelector(".modal-note");
    if (note) note.remove();
    const busy = panel.querySelector(".modal-busy");
    if (busy) busy.remove();
    const busyEl = h("div", `modal-busy ${failed ? "is-error" : ""}`);
    if (!failed) {
      const spinner = h("span", "spinner");
      spinner.setAttribute("aria-hidden", "true");
      busyEl.appendChild(spinner);
    } else {
      busyEl.appendChild(iconEl("alert", 14));
    }
    busyEl.appendChild(h("span", "", message));
    if (failed) {
      const retry = h("button", "secondary-button");
      retry.type = "button";
      retry.appendChild(h("span", "", t(this.lang, "result.retry")));
      retry.addEventListener("click", () => {
        this.pending = false;
        const state = this.state;
        if (state.result) this.showResult(state.result);
      });
      busyEl.appendChild(retry);
      const quit = h("button", "text-button");
      quit.type = "button";
      quit.appendChild(h("span", "", t(this.lang, "result.quit")));
      quit.addEventListener("click", () => {
        void api.quitApp().catch((error) => {
          // 写回途中拒绝退出：提示用户等待，而不是留下半残桌面。
          this.toast(errorText(this.lang, asAppError(error).code));
        });
      });
      busyEl.appendChild(quit);
    }
    panel.appendChild(busyEl);
  }

  private hideResult(): void {
    this.resultOpen = false;
    this.resultLayer.hidden = true;
    clear(this.resultLayer);
  }

  private showExitConfirm(): void {
    if (this.exitOpen || this.pending) return;
    this.exitOpen = true;
    clear(this.exitLayer);
    const panel = h("div", "modal modal-compact");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const title = h("p", "modal-title", t(this.lang, "exit.title"));
    title.id = "exit-title";
    panel.setAttribute("aria-labelledby", title.id);
    panel.appendChild(title);
    panel.appendChild(h("p", "modal-body", t(this.lang, "exit.body")));
    const actions = h("div", "modal-actions");
    const keep = h("button", "primary-button");
    keep.type = "button";
    keep.appendChild(h("span", "", t(this.lang, "exit.keep")));
    keep.addEventListener("click", () => this.hideExitConfirm());
    actions.appendChild(keep);
    const quit = h("button", "text-button");
    quit.type = "button";
    quit.appendChild(h("span", "", t(this.lang, "exit.confirm")));
    quit.addEventListener("click", () => {
      if (this.pending) return;
      this.pending = true;
      // 保留退出层，把内容换成「继续玩」作为动画期间的可见取消入口：
      // 点它 -> hideExitConfirm() -> cancelExit()，Esc 也走同一路径。
      clear(this.exitLayer);
      const cancelPanel = h("div", "modal modal-compact");
      cancelPanel.setAttribute("role", "dialog");
      cancelPanel.setAttribute("aria-label", t(this.lang, "exit.title"));
      const cancel = h("button", "primary-button");
      cancel.type = "button";
      cancel.appendChild(h("span", "", t(this.lang, "exit.keep")));
      cancel.addEventListener("click", () => this.hideExitConfirm());
      cancelPanel.appendChild(cancel);
      this.exitLayer.appendChild(cancelPanel);
      // 「退出」按钮随旧面板一起被移除，焦点会掉到 body；把焦点交给
      // 新的可见取消按钮，动画期间 Esc 才还能被覆盖窗收到。
      cancel.focus({ preventScroll: true });
      this.runExit(() => {
        void api.quitApp().catch((error) => {
          // 退出被拒（例如另一屏正在写回）：撤掉演出类，否则牌桌会停在
          // “全部翻走”的空白状态，再点继续游戏也看不到牌。
          this.cancelExit();
          this.toast(errorText(this.lang, asAppError(error).code));
        });
      });
    });
    actions.appendChild(quit);
    panel.appendChild(actions);
    this.exitLayer.appendChild(panel);
    this.exitLayer.hidden = false;
    keep.focus({ preventScroll: true });
  }

  private hideExitConfirm(): void {
    this.exitOpen = false;
    this.cancelExit();
    this.exitLayer.hidden = true;
    clear(this.exitLayer);
  }

  // --------------------------------------------------------------- layout

  private placeFloating(): void {
    if (!this.hudWrap) return;
    this.placeElement(this.hudWrap, this.view.slots);
  }

  private placeElement(
    element: HTMLElement,
    slots: SlotView[],
  ): void {
    const rect = element.getBoundingClientRect();
    const width = rect.width || 320;
    const height = rect.height || 48;
    const margin = 20;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const candidates = [
      { x: (viewportWidth - width) / 2, y: viewportHeight - height - margin },
      { x: (viewportWidth - width) / 2, y: margin },
      { x: margin, y: viewportHeight - height - margin },
      { x: viewportWidth - width - margin, y: viewportHeight - height - margin },
      { x: margin, y: margin },
      { x: viewportWidth - width - margin, y: margin },
    ];
    let best = candidates[0];
    let bestOverlap = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      let overlap = 0;
      for (const slot of slots) {
        const overlapX = Math.max(
          0,
          Math.min(candidate.x + width, slot.x + slot.w) - Math.max(candidate.x, slot.x),
        );
        const overlapY = Math.max(
          0,
          Math.min(candidate.y + height, slot.y + slot.h) - Math.max(candidate.y, slot.y),
        );
        overlap += overlapX * overlapY;
      }
      if (overlap < bestOverlap) {
        bestOverlap = overlap;
        best = candidate;
      }
      if (overlap === 0) break;
    }
    element.style.transform = `translate3d(${best.x}px, ${best.y}px, 0)`;
  }

  private toast(message: string): void {
    this.toastElement.textContent = message;
    this.toastElement.hidden = false;
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastTimer = null;
      this.toastElement.hidden = true;
    }, 2600);
  }
}

export function renderFatal(root: HTMLElement, message: string, lang: Lang): void {
  clear(root);
  root.classList.add("overlay-root");
  const layer = h("div", "modal-layer");
  const panel = h("div", "modal modal-compact");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  const title = h("p", "modal-title", t(lang, "app.name"));
  title.id = "fatal-title";
  panel.setAttribute("aria-labelledby", title.id);
  panel.appendChild(title);
  panel.appendChild(h("p", "modal-body", message));
  const actions = h("div", "modal-actions");
  const quit = h("button", "primary-button");
  quit.type = "button";
  quit.appendChild(h("span", "", t(lang, "result.quit")));
  quit.addEventListener("click", () => {
    void api.quitApp();
  });
  actions.appendChild(quit);
  panel.appendChild(actions);
  layer.appendChild(panel);
  root.appendChild(layer);
}
