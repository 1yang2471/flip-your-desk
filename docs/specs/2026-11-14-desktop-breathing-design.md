# 桌面呼吸 · 设计规格 · 2026-11-14

状态：设计已批准，待转实施计划（本文件不改任何实现代码）· 来源：2026-11-14 玩法扩展头脑风暴 · 前置：v0.2.0 已发布，Phase 0 跨编译门已跑通

> 位置说明：brainstorming 技能默认把 spec 放 `docs/superpowers/specs/`，本项目已有 `docs/specs/` 目录与 `2026-11-14-v0.1.1-consolidation-design.md` 先例，按项目约定放此处。

## 背景与目标

`flip-your-desk` 把 Windows 桌面图标变成记忆翻牌游戏，现有独一份的载体是：真桌面、真图标、真壁纸、覆盖层空白区不吃点击（可边玩边干活）、开局两张截图差分抠卡面、`original-layout.json` 备份、纯鼠标、完全离线。

本轮目标：**在不脱离「本地轻量」前提、不新增任何持久化数据/网络/后端改动的情况下，把「桌面感」与「仪式感」补上**——让牌桌表现得像桌面的一部分，而不是浮在桌面上的一层网页。

发散阶段共提出 15 个点子（A1–A5 桌面变量、B1–B5 反常规规则、C1–C4 摸鱼属性、D1–D3 数据叙事）。用户圈定 A1/A3/A4/A5/C1/C2/C4 七个可做，经范围分解后收敛为三组独立子系统：

| 组 | 点子 | 判定 |
|---|---|---|
| 1 桌面感渲染层 | A4 / C1 / C2 / C4（A3 经像素源核实后砍掉，见下） | **本轮范围**（推荐，用户选定） |
| 2 偷天换日 | A1 | 新玩法模式，需动 `game.rs` 状态机与启动窗，另立 spec |
| 3 桌面考古 | A5 | 备份从单份变多份历史，隐私面扩大，另立 spec |

方向选择上另有两条被否证/否决的路径：
- **方向乙（因果动画，动 `save_and_exit` 时序）**：会让动画靠近桌面写回路径，撞 `AGENTS.md`「桌面写回路径改动必须真机验证」与数据安全底线，否决。
- **方向丙（只做 C1+C2+A3）**：丢了最有记忆点的退出仪式，未选。

最终采用**方向甲「桌面呼吸」**：全部押在纯前端，后端零改动。

### 两处实测更正（写设计前核对代码所得）

1. **全局干净壁纸没有传给前端**。`windows.rs` 的 `capture_window` 拿到 `RgbaImage` 后，`tone_for_cell(clean, ...)` 只用它算卡背深浅，随后 `IconRecord.icon_png` 是**按格裁好的小图**下发。A3「壁纸牌桌」若要精确纹理就得新增壁纸 IPC（多屏/4K 下几 MB base64）或动 `model.rs` 数据结构。**用户决定「壁纸算了不切换了」→ A3 整项砍掉**，卡背色调维持现状不动。
2. **A4/C4 不能碰真实退出路径**。`lib.rs` 的 `save_and_exit` / `restore_and_exit` 是一条数据安全关键路径（`restore_desktop_icons()` → `apply_positions()` → `app.exit(0)`，注释明写"写回可能耗时数秒""绝不把用户困在恢复失败的重试循环里"）。把动画塞进这条路径等于拿动画阻塞/延迟真图标恢复，不可接受。→ A4 降级为「覆盖层里的假图标演戏」。

## 范围

**做（3 件；C1 已于手测后下线）**

- ~~**C1 摸鱼模式**~~ **已下线**（2026-11-14 手测后用户拍板）：覆盖窗是 `focusable(false)`（为免点击卡片把覆盖层抬到普通窗口之上），`focus` 事件不可靠，「切回来自动恢复」实际变成「要点一下才恢复」，收益小于体验代价。相关 `.veiled` / `.hud-dozing` CSS、`PresenceController` 的 onHide/onShow、face 的 `data-tone` 全部移除。
- **C2 呼吸间隔**：连续 8 秒无任何操作（常量 `IDLE_MS = 8000`，不进设置），卡背极慢起伏一次（1px 级），不弹任何东西。
- **C4 退出仪式**：HUD ✕ 的退出确认里点「退出」（`quit_app`）、以及结算里点「回到原布局」（`restoreAndExit`）时，卡背按 y/x 排序依次翻回真图标（多米诺，总时长常量 `REVEAL_MS = 1000`），**演完才**调对应命令。局中退出确认只调 `quit_app`（已核实 `overlay.ts`）；`restoreAndExit` 属于结算弹窗而非退出确认。
- **A4（最终降级版）：只保留时序，不做滑行**：结算里点「保存新布局」（`saveAndExit`）时，同样走 C4 的多米诺演出，**演完才**调 `saveAndExit`；**不做假图标滑行**。真实桌面恢复与写回仍由现有命令原样执行。结算里「再来一局」不演动画，保持原样。

> 修订记录（2026-11-14 审查后）：初版 A4 写了「假图标滑到目标槽位再淡出」，但实测发现 `--slide-x/--slide-y` 无 JS 赋值、且卡片定位靠内联 `transform` 压过 `.sliding` 类规则，滑行在真实 DOM 下既不滑也不淡。经用户拍板，**整项砍掉假滑行**（`.sliding` 类、`slide` 参数、`--slide-*` 变量全部移除），只保留「演完才发命令」这一有实际价值的语义。
>
> 修订记录（2026-11-14 手测后）：C1 摸鱼整项下线（见上），附带修掉启动窗切语言闪透明、选中卡叠两圈金边。
>
> 修订记录（2026-11-14 二轮手测后）：Esc 取消选卡整项下线（用户拍板）——覆盖窗 `focusable(false)` 且卡片的 `pointerdown` 被 `preventDefault`，键盘路径不可靠；取消选中改为再点一次该卡。`focus()` 保留给其余 Esc 动作（无选中时开退出确认、关闭退出确认、取消退出演出），卡片本身不画焦点环（避免与 `.is-selected` 叠圈）。退出仪式在结算屏（全正面卡）无动画——`.revealing` 只匹配 `.card-back`；正面卡改用独立 `rotate` 属性翻走（不替换入场 `transform` 动画，取消可平滑转回），逐卡排期预留 320ms，保证最后一张也在 `REVEAL_MS` 内翻完。

**明确不做**

- A3 壁纸牌桌（已砍）、A1 偷天换日、A5 桌面考古、B/D 各组全部点子
- 任何新玩法模式、任何新持久化设置、任何新 IPC 命令、任何 i18n 新文案、任何音效新素材、任何新依赖
- **`src-tauri/**` 全部零改动**：`game.rs` / `lib.rs` / `platform/*` / `model.rs` 一行不动
- A4 的"真图标滑到新位置"版本（需改 `save_and_exit` 调用时序）
- A4 的"假图标滑行/淡出"版本（实测无效，已整项移除）

## 硬边界

1. C1 是**纯视觉伪装**：不写 `Round`、不发 `state-changed`、不调 `api.*`；焦点恢复靠前端自己记的那份「失焦前正面列表」（实际实现是正面 DOM 不销毁，只加类，因此无需存列表）。
2. C4/A4 的动画**只在覆盖层里演假图标**；动画期间不发游戏命令、不改 `Round`、不读后端、不碰 `writing`。后端完全不知道有动画存在，**不新增 `writing` 态**。
3. 动画期间用户又点别的（退出确认里反悔、结算里点「再来一局」）→ **动画立刻取消、DOM 状态复原、`pending` 归位**，`then()` 绝不执行。
4. `prefers-reduced-motion` 下所有动画时长归零，直接执行原命令（沿用项目现有全局规则）。
5. 不注册第二个 `blur` 处理器：现有 `overlay.ts` 已用 `blur` 取消拖拽，改由 `PresenceController` 统一派发，避免两者打架。

## 架构

新增两个前端单元，各自单一职责、互不 import：

| 单元 | 做什么 | 怎么用 | 依赖 |
|---|---|---|---|
| `PresenceController`（`src/presence.ts`） | 把窗口活跃度变成 3 个事件 | `new PresenceController({onHide,onShow,onIdle,idleMs})` + `dispose()` | 仅 `window` / `document` 事件；**不碰 DOM** |
| `ExitChoreography`（`src/choreography.ts`） | 演一段可取消的动画再执行回调 | `play(then: () => void)` / `cancel()` | 传入的卡片元素列表 + CSS 类名；**不知道什么是退出、什么是保存** |

`overlay.ts` 是唯一知道「失焦该盖牌、退出该多米诺」的地方，只多两处接线。改动画不影响摸鱼逻辑，反之亦然。

## 数据流与时序

**C1 摸鱼（无后端往返）**

```
window blur / document visibilitychange(hidden)
  → PresenceController.onHide()
  → 给 .card-inner 统一加 .veiled（CSS 翻到背面，不销毁正面 DOM）
  → HUD 加 .hud-dozing（收成小金点，退出按钮保留可点）

window focus / visible
  → onShow() → 移除 .veiled / .hud-dozing
  → 正面 DOM 一直在，自然恢复原样；零重绘、零状态同步
```

正面 DOM 不销毁，保证拖拽中途失焦再回来卡不会卡在半空（与现有 `blur→cancel` 拖拽取消共存）。

**C2 呼吸**

```
任何 pointerdown / click / drag 结束 → PresenceController.resetIdle()
空闲 ≥ IDLE_MS(8000ms) → onIdle() → 给卡背容器加 .breathing（一次 1px 级 keyframe，播完自动移除）
reduced-motion 或 失焦(.veiled) 期间不触发
```

只加类、不建元素、不播音。

**C4 / A4（统一由 ExitChoreography 管）**

```
用户点「退出」(quit_app) /「回到原布局」(restoreAndExit) /「保存新布局」(saveAndExit)
  → 按钮立即置 pending（沿用现有防重入）
  → choreography.play(then)
       ├ 取牌桌全部 .card（不只 backs：结算时多数槽位已是正面），按 slot 的 y/x 排序
       ├ 卡背加 .revealing 演翻回；正面卡用独立 rotate 属性翻走（不顶掉入场动画）
       ├ 依次加 .revealing 演多米诺翻回
       └ 全部完成（REVEAL_MS = 1000ms，含最后一张 320ms 翻回；reduced-motion 下 0ms）
  → then() 才调用对应原有的 quit_app / restoreAndExit / saveAndExit
```

**取消路径**：动画中按 Esc → `onKeyDown` 在 `pending && choreography` 时走 `cancelExit()`；退出确认层在动画期间保留一个「继续玩」按钮作为可见取消入口，点它也走 `cancelExit()`。`cancel()` 移除所有类、清主/逐卡定时器、`pending` 归位，`then()` 不执行。

**错误路径（沿用现有，不动）**：`saveAndExit` 失败时前端已有 `showBusy(..., true)` 与重试；`then()` 发出后覆盖窗由后端 `app.exit(0)` 或错误弹窗接管，不产生「演完了又退回牌桌」的错乱。

## 测试与回归

现有门：`npm test`（`tests/ui.test.mjs`，原 38 条，headless Edge + CDP 打开真实构建 CSS 注入 DOM 场景）+ Rust 三门。后端零改动，Rust 门**不新增任何断言**，只证明不回归。

> 测试修订（2026-11-14 审查后）：初版新增的 8 条断言几乎全是 `readFileSync` 查源码字符串，被 `@tester` 独立审查判定为**假阳性**——最典型的是 `.veiled` 用例只断言 DOM 恒在、还把类加在与生产相反的 `.card` 上，恰好绕开了真实缺陷。现改为**基于 `getComputedStyle` 与真实行为的断言**：
> - `scene()` 忠实复刻生产 DOM（veiled 加在 `.overlay-root`、back-inner 带内联 `card-in`、卡片带内联定位 transform）
> - C1：`veiled` 加在 root 后断言 `animationName === "none"` 且 transform 是 `rotateY(180°)` 的 matrix3d；HUD dozing 后断言退出按钮 `elementFromPoint` 命中自身
> - C2/C4：内联 `card-in` 存在时断言 `.revealing`/`.breathing` 的 computed `animationName` 真是 `card-reveal`/`card-breathe`
> - `ExitChoreography`：用 `typescript.transpileModule` 把**真源码**注入 CDP 页面执行，断言 `play→cancel→then 未调用`、`play→完成→then 执行一次`
> - S4：断言 `onKeyDown` 在 pending 时有 `cancelExit()` 分支而非无条件 return
> - 硬边界回归：断言 `src-tauri/` 未出现动画/空闲标记、`runExit` 内部零 IPC
> - `package.json` 的 `test` 脚本前置 `npm run build`（clean clone 可直接跑）；`ci.yml` 与 `release.yml` 均补 `npm test` 步骤

**验收标准（可量化）**

1. `npm run check` + `npm test` 全绿，测试条数 ≥ 38 + 新增项
2. `cargo fmt --check` / `cargo test`（38 passed, 1 ignored）/ `cargo clippy --all-targets -- -D warnings` 与基线完全一致
3. 真机手验 6 条（本机 Windows 可做，无需新设备）：失焦→盖正面→切回原样恢复；空闲 8s 呼吸一次；拖拽中途失焦不卡半空；Esc 退出多米诺后图标真的回来；结算保存后桌面真的按新布局排列；退出动画期间点「继续玩」/按 Esc 能干净取消
4. 手验补充：`prefers-reduced-motion` 开启时动画全部直通、功能不变

**风险与缓解**

- C1 与现有拖拽 `blur→cancel` 监听打架 → C1 只加/移 CSS 类，不注册第二个 `blur` 处理器，统一由 `PresenceController` 派发
- 内联 `style.animation`（发牌入场）优先级压过类规则 → 入场动画播完由 `animationend` 清掉内联；同时 CSS 侧对 `.revealing`/`.breathing`/`.veiled` 用 `!important` 兜底
- 结算时 `backs` 多为正面导致多米诺无卡可演 → `runExit` 从 `board.querySelectorAll(".card")` 取全部卡片按 slot 排序

## 落地文件与提交边界

| 文件 | 改动 |
|---|---|
| `src/presence.ts`（新） | `PresenceController`，仅事件 → 3 回调 |
| `src/choreography.ts`（新） | `ExitChoreography`，`play(then)` / `cancel()`（无 slide 参数） |
| `src/overlay.ts` | 初始化 Presence、三个按钮的 `then` 包进 choreography、`onKeyDown` 取消分支、发牌入场动画播完清内联 |
| `src/styles.css` | `.veiled` / `.hud-dozing` / `.breathing` / `.revealing` 四组类（`!important` 压内联）+ reduced-motion 覆盖；**无 `.sliding`** |
| `tests/ui.test.mjs` | 新增基于 `getComputedStyle` / 真源码转译执行的断言，`scene()` 复刻生产 DOM |
| `package.json` | `test` 脚本前置 `npm run build` |
| `.github/workflows/ci.yml` / `release.yml` | 各补一步 `npm test` |

**明确不碰**：`src-tauri/**`（全部）、`src/audio.ts`、`src/i18n.ts` + `src/locales/*`（零新文案）、`src/launcher.ts`、`src/types.ts` / `src/api.ts`（零新 IPC）、`tauri.conf.json`（零新依赖）、六处版本号（不发版）。

**提交边界**：一个中文 conventional commit，**只 commit 不 push**，不 bump 版本、不打 tag、不发版；提交前本地跑全套门并贴原样输出，`git log --oneline` 贴原文核对。

## YAGNI 复查

砍掉了 A3、A1、A5、B/D 全部点子、新设置项、新 IPC、新文案、新音效、后端改动、A4 真图标滑行、**A4 假图标滑行**（实测无效）。剩下四个点子共用一个活跃度控制器与一个动画编排器，无投机性扩展、无可配置化、无未要求的抽象。

## 决策记录（本轮四轮收敛）

1. 产出性质 → 用户圈定 A1/A3/A4/A5/C1/C2/C4 七个可做，范围分解后选组 1
2. 方向 → 方向甲「桌面呼吸」（纯前端，后端零改动）
3. A3 像素源 → 用户「壁纸算了不切换了」→ A3 整项砍掉
4. C1 恢复语义 → 自动原样恢复
5. 设计四段（范围与硬边界 / 数据流与时序 / 测试与回归 / 落地与提交边界）逐段获批，整体批准写 spec
