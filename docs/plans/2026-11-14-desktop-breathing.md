# 桌面呼吸 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task (use a subagent-driven-development or executing-plans skill if one is installed). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在纯前端给覆盖层加四个体验点（C1 摸鱼 / C2 呼吸 / C4 退出仪式 / A4 降级版图标滑行），后端零改动。

**Architecture:** 新增两个互不 import 的前端单元——`PresenceController` 把 `blur`/`focus`/`visibilitychange` 与空闲计时变成三个回调；`ExitChoreography` 演一段可取消的动画再执行回调。`overlay.ts` 是唯一接线点，只加/移 CSS 类与把三个按钮的 `then` 包进编排器，不发任何新 IPC、不动游戏状态。

**Tech Stack:** TypeScript 5.9（strict，`npm run check` 走 `tsc --noEmit`）、原生 CSS、Vite 构建、`tests/ui.test.mjs`（无头 Edge + CDP `Runtime.evaluate`，也用 `readFileSync` 做源码静态断言）。无新依赖。

> 位置说明：writing-plans 技能默认 `docs/superpowers/plans/`，本项目已有 `docs/plans/` 计划目录与 `docs/specs/` 规格目录，按项目约定放此处。
> 对应规格：`docs/specs/2026-11-14-desktop-breathing-design.md`（已批准）。
> 提交边界：**每个 Task 一个中文 conventional commit，只 commit 不 push**；全程不 bump 版本、不打 tag、不发版。
>
> **⚠ 后续修订（2026-11-14 审查后）**：本计划执行完毕后，`@tester` 独立审查 + CDP 实测发现 4 个严重缺陷（CSS 选择器与加类位置不匹配、内联 animation 压过类规则、A4 假滑行无效、动画不可取消），且新增断言多为假阳性。**下方任务正文保留为历史记录，不要再照抄执行**；最终实现以 [spec 修订版](../specs/2026-11-14-desktop-breathing-design.md) 与实际代码为准：A4 假滑行整项砍掉、测试改为 `getComputedStyle` / 真源码转译执行的真实断言、`npm test` 前置 build、CI/release 补 `npm test`。

---

## 现状（实施者必读，零上下文）

- `src/overlay.ts` 的 `OverlayGame` 类：`init()` 依次 `buildShell()/buildHud()/buildBoard()/applyState()/bindEvents()`；`destroy()` 清理定时器与监听（第 275 行）。
- 卡背/卡面是 `<button class="card card-back|card-face">` 内嵌 `<span class="card-inner card-back-inner|card-face-inner">`；3D 翻转用 `backface-visibility:hidden` + `rotateY`。`.card-inner` 有 `pointer-events:none`（src/styles.css:637）。
- HUD 容器是 `this.hudWrap`（`.hud-wrap`，src/styles.css:933）。
- `pending` 是 `OverlayGame` 的统一防重入标志（第 73 行）。
- **局中退出确认**（`showExitConfirm`，约 1095 行）的「退出」按钮直接 `void api.quitApp()`，无 pending。
- **结算弹窗**（约 940–1010 行）三个按钮：`replay`（`api.replayRound()`）、`save`（`api.saveAndExit()`）、`restore`（`api.restoreAndExit()`）；save/restore 已用 `pending` + `showBusy()`。
- `buildBoard()` 已有排序：`[...this.view.slots].sort((a, b) => a.y - b.y || a.x - b.x)`（第 239 行）。
- `src/styles.css:1222` 有全局 `@media (prefers-reduced-motion: reduce)` 把动画时长压到 `0.01ms !important`。
- **现有拖拽的 `blur` 监听**（`src/overlay.ts:628`）是拖拽开始到结束期间临时注册的 `window.addEventListener("blur", cancel)`，与常驻的 `PresenceController` 不是同一个，不需要合并；`PresenceController` 是 `init()` 时注册一次、`destroy()` 时移除。
- 测试：`tests/ui.test.mjs` 用 `test(name, fn)` 注册；`fresh(expression)` 重新导航后用 CDP `Runtime.evaluate` 求值（用于 CSS/DOM 行为）；`readFileSync(join(ROOT, "src/..."), "utf8")` 用于源码静态断言。`scene()` 生成的 HTML 只有一张 `#back` 和一张 `#face`。
- 测试门：`npm run build` 先产出 `dist/assets/index-*.css`（测试读它），再 `npm test`；`npm run check` 是类型检查。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/presence.ts`（创建） | `PresenceController`：窗口活跃度 → `onHide`/`onShow`/`onIdle` 三回调 + `resetIdle()` + `dispose()`；不碰 DOM |
| `src/choreography.ts`（创建） | `ExitChoreography`：`play(then)` / `cancel()`；只管动画编排与取消，不知业务语义 |
| `src/styles.css`（修改） | 追加 `.veiled` / `.hud-dozing` / `.breathing` / `.revealing` / `.sliding` 规则 + reduced-motion 覆盖 |
| `src/overlay.ts`（修改） | 初始化 Presence、接线 C1/C2、把三个按钮的 `then` 包进 choreography、`destroy()` 清理 |
| `tests/ui.test.mjs`（修改） | 新增 CSS 行为断言 + 源码边界断言 |

明确不碰：`src-tauri/**`、`src/audio.ts`、`src/i18n.ts`、`src/locales/*`、`src/launcher.ts`、`src/types.ts`、`src/api.ts`、`package.json`、`tauri.conf.json`、六处版本号。

---

### Task 1: `PresenceController`（C1/C2 的事件源）

**Files:**
- Create: `src/presence.ts`
- Test: `tests/ui.test.mjs`

- [ ] **Step 1: 写失败测试（源码静态断言）**

在 `tests/ui.test.mjs` 的 `tests` 数组末尾、`let failed = 0;` 之前，追加：

```js
test("PresenceController: 只派发三个回调、不碰 DOM、可 dispose", () => {
  const f = readFileSync(join(ROOT, "src/presence.ts"), "utf8");
  assert.match(f, /export class PresenceController/, "导出 PresenceController");
  assert.match(f, /onHide\?:/, "构造参数含 onHide");
  assert.match(f, /onShow\?:/, "构造参数含 onShow");
  assert.match(f, /onIdle\?:/, "构造参数含 onIdle");
  assert.match(f, /resetIdle\(\)/, "暴露 resetIdle");
  assert.match(f, /dispose\(\)/, "暴露 dispose");
  assert.match(f, /addEventListener\("blur"/, "监听 blur");
  assert.match(f, /addEventListener\("focus"/, "监听 focus");
  assert.match(f, /addEventListener\("visibilitychange"/, "监听 visibilitychange");
  assert.ok(!/querySelector|classList|createElement|appendChild/.test(f), "PresenceController 不操作 DOM");
  assert.match(f, /IDLE_MS\s*=\s*8000/, "空闲阈值常量为 8000ms");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: 新增用例 FAIL，报 `ENOENT: no such file or directory, open '...src/presence.ts'`（文件不存在）。其余 38 条仍 PASS。

- [ ] **Step 3: 最小实现**

创建 `src/presence.ts`，完整内容：

```ts
/** 窗口活跃度 → 三个回调。刻意不碰 DOM：加类/移类由 OverlayGame 决定。 */
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run check && npm test`
Expected: `tsc --noEmit` 无输出（exit 0）；`npm test` 新增用例 PASS，全部 39 条 PASS。

> 注：`npm test` 读的是 `dist/assets/index-*.css`，本 Task 未改 CSS，若 dist 是旧的也不影响；但为保险，第一次跑前先 `npm run build`。

- [ ] **Step 5: Commit**

```bash
git add src/presence.ts tests/ui.test.mjs
git commit -m "feat(overlay): 新增 PresenceController（窗口活跃度事件源）"
```

---

### Task 2: C1/C2 的 CSS 类与行为

**Files:**
- Modify: `src/styles.css`（在 `@media (prefers-reduced-motion: reduce)` 块**之前**追加）
- Test: `tests/ui.test.mjs`

- [ ] **Step 1: 写失败测试（CSS 行为断言）**

在 `tests/ui.test.mjs` 追加三条：

```js
test("摸鱼：.veiled 把正面翻回背面且不销毁正面 DOM", async () => {
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  assert.match(css, /\.card\.veiled \.card-face-inner/, ".veiled 作用于卡面内层");
  assert.match(css, /\.card\.veiled[\s\S]{0,120}rotateY\(180deg\)/, "翻回背面");
  const out = await fresh(`(() => {
    const face = document.getElementById('face');
    face.classList.add('veiled');
    return { stillThere: document.getElementById('face') !== null };
  })()`);
  assert.ok(out.stillThere, "正面 DOM 不被销毁");
});

test("摸鱼：.hud-dozing 把 HUD 收成小金点且禁止 reduced-motion 外动画", async () => {
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  assert.match(css, /\.hud-dozing/, "存在 .hud-dozing 规则");
  assert.match(css, /prefers-reduced-motion: reduce/, "沿用全局 reduced-motion 块");
});

test("呼吸：.breathing 是一次性 1px 起伏、播完由 JS 移除、reduced-motion 直通", () => {
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  assert.match(css, /@keyframes card-breathe/, "存在呼吸 keyframe");
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  assert.match(f, /animationend/, "播完移除类靠 animationend 监听");
  assert.match(f, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/, "reduced-motion 判定存在");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && npm test`
Expected: 三条新用例 FAIL（`.hud-dozing`/`card-breathe` 未定义、`getComputedStyle` 的 transform 未变、`overlay.ts` 无 `animationend`）。

- [ ] **Step 3: 最小实现（CSS）**

在 `src/styles.css` 的 `@media (prefers-reduced-motion: reduce)` 块之前追加：

```css
/* 桌面呼吸：C1 摸鱼 —— 失焦时正面视觉盖上（DOM 不销毁），HUD 收成小金点。 */
.card.veiled .card-face-inner {
  transform: rotateY(180deg);
  animation: none;
}

.hud-wrap.hud-dozing .hud {
  width: 12px;
  height: 12px;
  padding: 0;
  gap: 0;
  overflow: hidden;
  border-radius: 999px;
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: none;
}

.hud-wrap.hud-dozing .hud > *:not(.hud-button) {
  opacity: 0;
  pointer-events: none;
}

/* C2 呼吸：空闲一次 1px 级起伏，播完由 JS 移除类。 */
@keyframes card-breathe {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-1px); }
}

.card-back.breathing .card-back-inner {
  animation: card-breathe 2400ms var(--ease) 1;
}
```

- [ ] **Step 4: 最小实现（overlay.ts 接线 C1 + C2）**

在 `src/overlay.ts` 顶部 import 区追加：

```ts
import { PresenceController } from "./presence";
```

在 `OverlayGame` 类字段区（`private dealTimers: number[] = [];` 之后）追加：

```ts
  private presence: PresenceController | null = null;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
```

在 `init()` 里、`this.bindEvents();` 之后追加 `this.bindPresence();`：

```ts
  async init(): Promise<void> {
    this.buildShell();
    this.buildHud();
    this.buildBoard();
    this.applyState(this.state, true);
    this.bindEvents();
    this.bindPresence();
    window.addEventListener("beforeunload", () => this.destroy());
  }
```

新增两个私有方法（放在 `destroy()` 之前）：

```ts
  private bindPresence(): void {
    this.presence = new PresenceController({
      onHide: () => {
        this.root.classList.add("veiled");
        this.hudWrap.classList.add("hud-dozing");
      },
      onShow: () => {
        this.root.classList.remove("veiled");
        this.hudWrap.classList.remove("hud-dozing");
      },
      onIdle: () => this.breathe(),
    });
    // 任何指针操作都重置空闲计时；C1 的隐藏态由 focus/blur 单独管。
    this.board.addEventListener("pointerdown", () => this.presence?.resetIdle());
  }

  private breathe(): void {
    if (this.reducedMotion.matches || this.root.classList.contains("veiled")) return;
    for (const back of this.backs.values()) {
      back.classList.remove("breathing");
      // 强制回流，保证同一个元素连续两次空闲都能重播。
      void back.offsetWidth;
      back.classList.add("breathing");
      back.addEventListener(
        "animationend",
        () => back.classList.remove("breathing"),
        { once: true },
      );
    }
  }
```

在 `destroy()` 的 `this.unlisteners = [];` 之后追加：

```ts
    this.presence?.dispose();
    this.presence = null;
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run check && npm run build && npm test`
Expected: 类型检查通过；三条新用例 PASS，累计 42 条 PASS。

- [ ] **Step 6: 补 C1 边界断言（源码静态）**

追加：

```js
test("摸鱼是纯视觉伪装：onHide/onShow 不发 IPC、不改游戏状态", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const start = f.indexOf("private bindPresence()");
  const end = f.indexOf("private breathe()");
  const block = f.slice(start, end);
  assert.match(block, /classList\.add\("veiled"\)/, "onHide 只加类");
  assert.match(block, /classList\.remove\("veiled"\)/, "onShow 只移类");
  assert.ok(!/api\.|invoke|emit|state-changed/.test(block), "Presence 接线块零 IPC / 零状态事件");
});
```

Run: `npm test` → 43 条 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/styles.css src/overlay.ts tests/ui.test.mjs
git commit -m "feat(overlay): 摸鱼模式与空闲呼吸（纯视觉，不改游戏状态）"
```

---

### Task 3: `ExitChoreography`（可取消的动画编排）

**Files:**
- Create: `src/choreography.ts`
- Test: `tests/ui.test.mjs`

- [ ] **Step 1: 写失败测试（源码静态断言）**

```js
test("ExitChoreography: then 在动画完成回调里、cancel 阻止 then、reduced-motion 直通", () => {
  const f = readFileSync(join(ROOT, "src/choreography.ts"), "utf8");
  assert.match(f, /export class ExitChoreography/, "导出 ExitChoreography");
  assert.match(f, /play\(then:/, "play 接收 then 回调");
  assert.match(f, /cancel\(\)/, "暴露 cancel");
  assert.match(f, /REVEAL_MS\s*=\s*1000/, "总时长常量 1000ms");
  assert.match(f, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/, "reduced-motion 判定");
  const playStart = f.indexOf("play(then:");
  const cancelStart = f.indexOf("cancel():");
  const playBlock = f.slice(playStart, cancelStart);
  assert.match(playBlock, /setTimeout/, "then 由定时器延后执行");
  assert.ok(!/^\s*then\(\);/m.test(playBlock), "then 不在点击同步路径里直接调用");
  assert.match(f, /cardTimers/, "逐卡定时器被持有，cancel 才能清干净");
  assert.match(f, /cardTimers\.push/, "逐卡定时器入册");
  const cancelBlock = f.slice(cancelStart, f.indexOf("private finish()"));
  assert.match(cancelBlock, /cardTimers/, "cancel 清理逐卡定时器");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: 新增用例 FAIL（`src/choreography.ts` 不存在）。

- [ ] **Step 3: 最小实现**

创建 `src/choreography.ts`，完整内容：

```ts
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
  play(then: () => void, slide = false): void {
    this.cancel();
    this.then = then;
    if (this.reducedMotion.matches) {
      this.finish();
      return;
    }
    this.cards.forEach((card, index) => {
      this.cardTimers.push(window.setTimeout(() => {
        card.classList.add("revealing");
        if (slide) card.classList.add("sliding");
      }, index * this.perCard));
    });
    this.timer = window.setTimeout(() => this.finish(), REVEAL_MS);
  }

  /** 取消：移除所有类、清掉主定时器与逐卡定时器，then 绝不执行。 */
  cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    for (const id of this.cardTimers) window.clearTimeout(id);
    this.cardTimers = [];
    this.then = null;
    for (const card of this.cards) {
      card.classList.remove("revealing");
      card.classList.remove("sliding");
    }
  }

  private finish(): void {
    this.timer = null;
    this.cardTimers = [];
    const then = this.then;
    this.then = null;
    then?.();
  }
}
```

> 实现注记（修正）：逐卡 `setTimeout` **必须**持有 id 并在 `cancel()` 里清掉。否则取消之后那些 timer 仍会触发，把 `.revealing` 重新加回卡片上——类移除抵消不了未来的回调。这不是 YAGNI，是取消语义的正确性。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run check && npm test`
Expected: 类型检查通过；新增用例 PASS，累计 44 条 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/choreography.ts tests/ui.test.mjs
git commit -m "feat(overlay): 新增 ExitChoreography（可取消的退出动画编排）"
```

---

**续篇**：Task 4（CSS + 三个按钮接线）与 Task 5（全套门 + 真机手验）见 [2026-11-14-desktop-breathing-part2.md](2026-11-14-desktop-breathing-part2.md)。两个文件合起来是一份完整计划，按 pre-commit 的 20KB 文件约束拆分。
