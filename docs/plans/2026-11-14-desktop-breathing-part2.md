# 桌面呼吸 Implementation Plan · 续篇（Task 4–5）

> 本文件是 [2026-11-14-desktop-breathing.md](2026-11-14-desktop-breathing.md) 的续篇，合起来是一份完整计划。Header（Goal / Architecture / Tech Stack）、现状说明、File Structure 与 Task 1–3 见主文件；按 pre-commit 的 20KB 文件约束拆分。继续用 checkbox 逐项执行。

---

### Task 4: `.revealing` / `.sliding` CSS + 三个按钮接线

**Files:**
- Modify: `src/styles.css`（reduced-motion 块之前）
- Modify: `src/overlay.ts`（三个按钮 + 取消路径 + destroy）
- Test: `tests/ui.test.mjs`

- [ ] **Step 1: 写失败测试（CSS + 源码接线断言）**

```js
test("退出仪式与图标滑行：CSS 类与三个按钮接线齐全", () => {
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  assert.match(css, /@keyframes card-reveal/, "存在翻回 keyframe");
  assert.match(css, /\.sliding/, "存在滑行类");
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  assert.match(f, /new ExitChoreography/, "创建了编排器");
  assert.match(f, /\.play\(/, "存在 play 调用");
  assert.match(f, /\.cancel\(\)/, "存在 cancel 调用");
  assert.match(f, /api\.quitApp\(\)/, "退出仍调 quit_app");
  assert.match(f, /api\.restoreAndExit\(\)/, "回到原布局仍调 restoreAndExit");
  assert.match(f, /api\.saveAndExit\(\)/, "保存仍调 saveAndExit");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && npm test`
Expected: 新用例 FAIL（CSS 无 `card-reveal`、overlay 无 `ExitChoreography`）。

- [ ] **Step 3: 追加 CSS**

在 `src/styles.css` 的 reduced-motion 块之前追加：

```css
/* C4 退出仪式：卡背依次翻回（多米诺）；A4：假图标滑向目标槽后淡出。 */
@keyframes card-reveal {
  0% { transform: rotateY(0deg); }
  100% { transform: rotateY(-180deg); }
}

.card-back.revealing .card-back-inner {
  animation: card-reveal 320ms var(--ease) forwards;
}

.card-back.sliding {
  transition: transform 260ms var(--ease), opacity 260ms var(--ease);
  transform: translate3d(var(--slide-x, 0px), var(--slide-y, 0px), 0);
  opacity: 0;
}
```

- [ ] **Step 4: overlay.ts 接线（import + 字段 + 辅助方法）**

顶部 import 区追加：

```ts
import { ExitChoreography } from "./choreography";
```

类字段区追加：

```ts
  private choreography: ExitChoreography | null = null;
```

新增私有方法（放在 `breathe()` 之后）：

```ts
  /** 按 y/x 排序取所有卡背元素，交给编排器；动画期间不发任何游戏命令。 */
  private runExit(then: () => void, slide = false): void {
    const ordered = [...this.view.slots].sort((a, b) => a.y - b.y || a.x - b.x);
    const cards = ordered
      .map((slot) => this.backs.get(slot.id))
      .filter((el): el is HTMLButtonElement => el !== undefined);
    this.choreography = new ExitChoreography(cards);
    this.choreography.play(then, slide);
  }

  /** 动画中用户反悔：移除类、pending 归位，then 不会执行。 */
  private cancelExit(): void {
    this.choreography?.cancel();
    this.choreography = null;
    this.pending = false;
  }
```

- [ ] **Step 5: 改三个按钮（逐个精确替换）**

**5a 局中退出确认的「退出」按钮**：把

```ts
    quit.addEventListener("click", () => {
      void api.quitApp();
    });
```

替换为：

```ts
    quit.addEventListener("click", () => {
      if (this.pending) return;
      this.pending = true;
      // 直接关层，不走 hideExitConfirm()：后者会 cancelExit() 干掉刚启动的动画。
      this.exitOpen = false;
      this.exitLayer.hidden = true;
      clear(this.exitLayer);
      this.runExit(() => void api.quitApp());
    });
```

**5b 结算「保存新布局」按钮**：把

```ts
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
```

替换为（A4 带滑行；`showBusy` 移到 `then` 内，避免动画先演完才显示"应用中"）：

```ts
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
              this.showBusy(panel, errorText(this.lang, payload.code), true);
            });
        }, true);
      });
```

**5c 结算「回到原布局」按钮**：把

```ts
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
```

替换为：

```ts
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
              this.showBusy(panel, errorText(this.lang, payload.code), true);
            });
        });
      });
```

> `replay`（再来一局）保持原样，不演动画（spec 明确）。

- [ ] **Step 6: 取消路径接线**

在 `hideExitConfirm()` 的 `this.exitOpen = false;` 之后追加 `this.cancelExit();`：

```ts
  private hideExitConfirm(): void {
    this.exitOpen = false;
    this.cancelExit();
    this.exitLayer.hidden = true;
    clear(this.exitLayer);
  }
```

`onKeyDown` 不改：Escape 在结算弹窗时按 spec 应忽略；退出确认打开时 Escape 已经走 `hideExitConfirm()`（上面已接 `cancelExit()`）。

`applyState()` **不改**：它在开局和每次 `state-changed` 都会跑，若在这里 `cancel()` 会在动画演到一半被后端状态推送无端打断。编排器的生命周期只由「用户反悔」（`cancelExit()`）与「窗口销毁」（`destroy()`）两处收口。

在 `destroy()` 里、`this.presence = null;` 之后追加：

```ts
    this.choreography?.cancel();
    this.choreography = null;
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npm run check && npm run build && npm test`
Expected: 类型检查通过；新用例 PASS，累计 45 条 PASS；原有 38 条不回归。

- [ ] **Step 8: 补硬边界回归断言（防动画塞回后端）**

```js
test("硬边界：后端零改动、动画期间零游戏命令", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
  assert.match(rust, /fn save_and_exit/, "save_and_exit 仍在");
  assert.match(rust, /fn restore_and_exit/, "restore_and_exit 仍在");
  assert.ok(!/revealing|choreography|ExitChoreography|IDLE_MS/.test(rust), "后端无动画/空闲标记");
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const start = f.indexOf("private runExit(");
  const end = f.indexOf("private cancelExit()");
  const block = f.slice(start, end);
  assert.ok(!/api\.|invoke|emit/.test(block), "runExit 内部零 IPC");
});
```

Run: `npm test` → 46 条 PASS。

- [ ] **Step 9: Commit**

```bash
git add src/styles.css src/overlay.ts tests/ui.test.mjs
git commit -m "feat(overlay): 退出仪式与保存滑行（动画纯覆盖层，后端零改动）"
```

---

### Task 5: 全套门 + 真机手验 + 收尾提交

**Files:** 无新增代码改动；只跑门、贴输出、必要时修。

- [ ] **Step 1: 前端门**

Run:
```bash
npm run check
npm run build
npm test
```
Expected: `tsc --noEmit` 无输出；`npm test` 全部 PASS（≥46 条），`process.exit(0)`。

- [ ] **Step 2: Rust 三门（证明后端零改动不回归）**

`cargo test` / `clippy` 需要 MSVC 环境，走项目脚本注入：

```bash
cd src-tauri && cargo fmt -- --check
cmd.exe /c "D:\workspace\flip-your-desk\scripts\run-cargo-test.cmd"
cmd.exe /c "call \"C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat\" >nul 2>&1 && cd /d D:\workspace\flip-your-desk\src-tauri && cargo clippy --all-targets -- -D warnings"
```

Expected: `cargo fmt --check` exit 0；`cargo test` = `38 passed; 0 failed; 1 ignored`；`clippy` `Finished dev profile` 且 exit 0。

- [ ] **Step 3: 真机手验 6 条（本机 Windows，无需新设备）**

逐条人工确认并记录结果：
1. 开局后 Alt-Tab 切走 → 所有翻开的正面盖上、HUD 收成小金点；切回 → **原样恢复**，步数/进度不变
2. 静置 8 秒 → 卡背起伏一次（1px），不弹任何东西
3. 拖拽中途 Alt-Tab 切走再回来 → 卡不卡在半空（与现有 `blur→cancel` 共存）
4. 局中 Esc → 点「退出」→ 卡背依次翻回约 1 秒 → 桌面图标真的回来
5. 结算点「保存新布局」→ 假图标滑行淡出 → 桌面真的按新布局排列；点「回到原布局」同样有多米诺
6. Windows 设置里开「减少动态效果」→ 四个动画全部直通、功能不变；动画进行中点「继续玩」/按 Esc → 干净取消、`pending` 归位

- [ ] **Step 4: 交差三查（贴原样输出）**

```bash
git status --short
git log --oneline -6
```
Expected: `git status --short` 为空（干净工作区）；`git log --oneline` 原文含本轮 4 个 commit（Task 1/2/3/4），不引用未核对的 hash。

- [ ] **Step 5: 若手验发现问题**

按 TDD 回到对应 Task 补一条失败测试 → 修 → 重跑全套门 → 追加一个 `fix:` commit。**不改 `src-tauri/**`**（硬边界）。

- [ ] **Step 6: 最终确认只 commit 不 push**

```bash
git status -sb
```
Expected: 显示 `## main...origin/main` 且无 `ahead` 提示（本轮 4 个 commit 只 commit 不 push；若此前本地已领先远端，领先数应保持不变）。**不 bump 版本、不打 tag、不发版。**

---

## 自查对照（写完计划后核对 spec）

| Spec 要求 | 覆盖 Task |
|---|---|
| C1 失焦盖正面 / HUD 收金点 / 自动原样恢复 / 纯视觉不碰状态 | Task 1 + Task 2（含 Step 6 边界断言） |
| C2 `IDLE_MS=8000` / 1px 起伏 / reduced-motion 与失焦不触发 / 播完移类 | Task 1 + Task 2 |
| C4 退出确认 `quit_app` + 结算 `restoreAndExit` 多米诺 / `REVEAL_MS=1000` / 演完才发 | Task 3 + Task 4 |
| A4 保存 `saveAndExit` 假图标滑行 / 再来一局不演动画 | Task 4 |
| 动画可取消 / `pending` 归位 / `then()` 不执行 | Task 3 `cancel()` + Task 4 Step 6 |
| reduced-motion 全部直通 | Task 2 CSS 全局块 + Task 3 `play()` 直通分支 |
| 不注册第二个 blur 处理器（与拖拽 blur 共存） | Task 1 现状说明 + 只在 `init` 注册一次 |
| 后端零改动 / 零新 IPC / 零新文案 / 零新依赖 | Task 4 Step 8 硬边界断言 + Task 5 Rust 门 |
| 测试沿用现有 `fresh()` / `readFileSync` 风格 | 全部 Task |
| 一个 commit 边界（本计划拆为 4 个 feat commit，见下方偏离说明） | Task 1/2/3/4 Step 5/7/9 |

**偏离说明（相对 spec「一个 commit」）**：writing-plans 技能要求 frequent commits（每 Task 一提交），与 spec 写的「一个中文 conventional commit」冲突。本计划按技能要求拆成 4 个 feat commit + 可能的 1 个 fix commit，每个都能独立编译/测试。**若用户坚持单个 commit**，在 Task 4 Step 9 用 `git reset --soft <本轮起始 HEAD>` 后一次性提交即可（注意：工作区守则禁止用 `git checkout` 还原；`reset --soft` 不丢改动）。
