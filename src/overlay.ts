import { listen } from "@tauri-apps/api/event";

import { api, asAppError } from "./api";
import { Sounds } from "./audio";
import { clear, h, iconEl } from "./dom";
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
    this.bindEvents();
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
    mute.appendChild(iconEl(this.state.muted ? "mute" : "volume", 14));
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

  private buildBoard(): void {
    for (const slot of this.view.slots) {
      this.ensureBack(slot);
    }
  }

  // --------------------------------------------------------------- events

  private clockTimer: number | null = null;
  private unlisteners: Array<() => void> = [];
  private readonly onKeyDownBound = (event: KeyboardEvent) => this.onKeyDown(event);

  private bindEvents(): void {
    void listen<PublicState>("state-changed", (event) => {
      this.applyState(event.payload, false);
    }).then((unlisten) => this.unlisteners.push(unlisten));
    // drag-hover 由本窗口本地 applyHover 已足够；后端广播在多显示器下会与
    // 本地状态交错，这里不再订阅，避免 outline 闪烁。
    document.addEventListener("keydown", this.onKeyDownBound);
    // 计时器只在状态事件里刷新会冻结：加 1 秒心跳。
    this.clockTimer = window.setInterval(() => this.updateClock(), 1000);
  }

  /** 覆盖窗关闭/重建时释放定时器与事件监听，避免多局叠加。 */
  destroy(): void {
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    document.removeEventListener("keydown", this.onKeyDownBound);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.pending) return;
    if (event.key === "Tab" && (this.resultOpen || this.exitOpen)) {
      const container = this.resultOpen ? this.resultLayer : this.exitLayer;
      this.trapFocus(container, event);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.resultOpen) {
        // 结算弹窗必须由用户明确选择，Esc 不叠加退出确认。
        return;
      }
      if (this.exitOpen) {
        this.hideExitConfirm();
      } else if (this.selectedIcon !== null) {
        this.clearSelection();
      } else {
        this.showExitConfirm();
      }
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
    if (!state.finished && this.resultOpen) this.pending = false;
    const previousFinished = this.state.finished;
    this.state = state;
    this.sounds.setMuted(state.muted);

    const iconSlot = new Map<number, number>();
    state.placements.forEach((icon, slot) => {
      if (icon !== null && icon !== undefined) iconSlot.set(icon, slot);
    });

    // 翻牌音与卡面创建的同一帧触发：drawCard 的 Promise 比 state-changed 晚，
    // 在那里播会导致声音落后于画面。只有「新出现」的正面才响，拖动换位不响。
    let newFace = false;
    for (const icon of this.view.icons) {
      const slotId = iconSlot.get(icon.id);
      if (slotId === undefined || !this.slots.has(slotId)) {
        this.dropFace(icon.id);
        continue;
      }
      if (!this.faces.has(icon.id)) newFace = true;
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
      const current = iconSlot.get(this.selectedIcon);
      if (current === undefined) {
        this.clearSelection();
      } else if (current !== this.selectedSlot) {
        this.selectedSlot = current;
      }
    }

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
    this.updateClock();
    this.placeFloating();
  }

  private updateClock(): void {
    if (!this.hudTime) return;
    const elapsed = this.state.finished && this.state.result
      ? this.state.result.elapsedMs
      : this.state.startedAtMs > 0
        ? Date.now() - this.state.startedAtMs
        : 0;
    this.hudTime.textContent = formatDuration(elapsed);
  }

  private updateConfirmButton(): void {
    const ready = this.state.remaining === 0 && !this.state.finished;
    const appeared = ready && this.confirmButton.hidden;
    this.confirmButton.hidden = !ready;
    if (appeared) {
      // CSS 动画只在元素创建时跑一次；hidden→显示必须重播，否则用户看不到弹出。
      this.confirmButton.style.animation = "none";
      void this.confirmButton.offsetWidth;
      this.confirmButton.style.animation = "";
      this.placeFloating();
    }
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
      inner.appendChild(h("span", "card-back-dot"));
      element.appendChild(inner);
      element.setAttribute("aria-label", t(this.lang, "overlay.cardBackAria"));
      element.addEventListener("click", () => this.onBackClick(slot.id));
      inner.style.animation = "card-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
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
      element.appendChild(inner);
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
    void api.drawCard(slotId).catch((error) => {
      const payload = asAppError(error);
      console.error("draw failed", payload);
      this.toast(errorText(this.lang, payload.code));
      this.sounds.error();
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
    window.removeEventListener("pointercancel", listeners.end, true);
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
    drag.element.style.transform = `translate3d(${drag.slotX + dx}px, ${drag.slotY + dy}px, 0)`;

    const point = this.globalPoint(event.clientX, event.clientY);
    const target = this.hitTest(point.x, point.y);
    if (target !== drag.hoverSlot) {
      drag.hoverSlot = target;
      this.applyHover(target);
    }
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
    const suppressTimer = window.setTimeout(() => {
      this.suppressClick = false;
    }, 200);
    // 中断（失焦/捕获丢失）或落在空白/原处：弹回原位，绝不悬停。
    // 落点与悬停高亮同源：玩家看到哪格高亮，松手就换哪格。重新 hitTest
    // 用的是松手瞬间的新坐标，边界上高亮 B、落点却变成 C，看起来就像
    // 一次拖拽同时改了三张卡。
    const target = event ? drag.hoverSlot : null;
    if (target === null || target === drag.fromSlot) {
      drag.element.style.transform = back;
      window.clearTimeout(suppressTimer);
      this.suppressClick = false;
      return;
    }
    const targetSlot = this.slots.get(target);
    if (targetSlot) {
      drag.element.style.transform = `translate3d(${targetSlot.x}px, ${targetSlot.y}px, 0)`;
    }
    this.sounds.drop();
    void api.moveCard(drag.fromSlot, target).catch((error) => {
      const payload = asAppError(error);
      console.error("move failed", payload);
      this.toast(errorText(this.lang, payload.code));
      this.sounds.error();
      drag.element.style.transform = back;
    });
  }

  private globalPoint(clientX: number, clientY: number): { x: number; y: number } {
    const scale = this.view.monitor.scale || 1;
    return {
      x: Math.round(this.view.monitor.x + clientX * scale),
      y: Math.round(this.view.monitor.y + clientY * scale),
    };
  }

  private hitTest(globalX: number, globalY: number): number | null {
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
      element.focus({ preventScroll: true });
    }
    this.hudHint.hidden = false;
    this.hudHint.textContent = t(this.lang, "overlay.selected");
    this.placeFloating();
  }

  private clearSelection(): void {
    if (this.selectedIcon !== null) {
      const element = this.faces.get(this.selectedIcon);
      element?.classList.remove("is-selected");
    }
    this.selectedIcon = null;
    this.selectedSlot = null;
    this.targetSlot = null;
    this.hudHint.hidden = true;
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
    void api
      .moveCard(from, to)
      .catch((error) => {
        const payload = asAppError(error);
        console.error("move failed", payload);
        this.toast(errorText(this.lang, payload.code));
        this.sounds.error();
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
    void api.moveCard(from, slotId).catch((error) => {
      const payload = asAppError(error);
      console.error("move failed", payload);
      this.toast(errorText(this.lang, payload.code));
      this.sounds.error();
    });
    this.clearSelection();
  }

  // ------------------------------------------------------- reveal effects

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

    panel.appendChild(h("p", "modal-title", t(this.lang, "result.title")));
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
      const save = h("button", "secondary-button");
      save.type = "button";
      save.appendChild(h("span", "", t(this.lang, "result.save")));
      save.addEventListener("click", () => {
        if (this.pending) return;
        this.pending = true;
        this.showBusy(panel, t(this.lang, "result.applying"));
        void api
          .saveAndExit()
          .catch((error) => {
            this.pending = false;
            const payload = asAppError(error);
            console.error("save failed", payload);
            this.showBusy(panel, errorText(this.lang, payload.code), true);
          });
      });
      actions.appendChild(save);

      const restore = h("button", "text-button");
      restore.type = "button";
      restore.appendChild(h("span", "", t(this.lang, "result.restore")));
      restore.addEventListener("click", () => {
        if (this.pending) return;
        this.pending = true;
        this.showBusy(panel, t(this.lang, "result.restoring"));
        void api
          .restoreAndExit()
          .catch((error) => {
            this.pending = false;
            const payload = asAppError(error);
            console.error("restore failed", payload);
            this.showBusy(panel, errorText(this.lang, payload.code), true);
          });
      });
      actions.appendChild(restore);
      panel.appendChild(actions);
      panel.appendChild(h("p", "modal-note", t(this.lang, "result.saveNote")));
    }

    this.resultLayer.appendChild(panel);
    this.resultLayer.hidden = false;
    const focusTarget = panel.querySelector<HTMLElement>("button");
    focusTarget?.focus({ preventScroll: true });
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
    panel.appendChild(h("p", "modal-title", t(this.lang, "exit.title")));
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
      void api.quitApp();
    });
    actions.appendChild(quit);
    panel.appendChild(actions);
    this.exitLayer.appendChild(panel);
    this.exitLayer.hidden = false;
    keep.focus({ preventScroll: true });
  }

  private hideExitConfirm(): void {
    this.exitOpen = false;
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
  panel.appendChild(h("p", "modal-title", t(lang, "app.name")));
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
