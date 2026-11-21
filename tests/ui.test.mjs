/**
 * 卡面盒模型 / i18n / 动效音效回归测试（无需额外依赖）。
 *
 * 用无头 Edge + CDP 打开真实构建产物里的 CSS，注入最小场景，
 * 断言用户可见的行为。整个套件只启动一次浏览器、复用同一个 CDP 连接，
 * 避免固定端口被上一个未退出的进程占用导致 flaky。
 *
 * 运行：npm test（需先 npm run build）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import ts from "typescript";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EDGE = ["C:", "Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"].join("\\");

const cssFile = readdirSync(join(ROOT, "dist/assets")).find((f) => /^index-.*\.css$/.test(f));
if (!cssFile) throw new Error("dist/assets 未找到 CSS，先跑 npm run build");
const cssText = readFileSync(join(ROOT, "dist/assets", cssFile), "utf8");

/** 一张卡背 + 一张透明卡面，忠实复刻 overlay.ts 的生产 DOM：
 *  - 卡背内层带内联 card-in 入场动画（buildBoard 设置）
 *  - 卡片带内联 transform 定位
 *  这样 CSS 断言测的是真实层叠，而不是一个被简化过的理想 DOM。 */
function scene() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${cssText}</style></head>
<body style="margin:0"><div class="overlay-root" id="root"><div class="board">
<button class="card card-back" id="back" style="width:76px;height:100px;transform:translate3d(150px,300px,0)">
  <span class="card-inner card-back-inner" id="backInner" style="animation:card-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1)"><span class="card-back-mark">?</span></span>
</button>
<button class="card card-face" id="face" style="width:76px;height:100px;transform:translate3d(200px,0,0)">
  <span class="card-inner card-face-inner is-photo" id="faceInner">
    <img class="face-image" src="data:image/png;base64,iVBORw0KGgo=" alt="">
    <span class="face-name" style="top:58px;left:24px;width:76px">此电脑</span>
  </span>
</button>
<div class="card card-face card-preview" id="preview" style="width:76px;height:100px;transform:translate3d(0,120px,0)">
  <span class="card-inner card-face-inner is-photo is-preview" id="previewInner">
    <img class="face-image" src="data:image/png;base64,iVBORw0KGgo=" alt="">
    <span class="face-name" style="top:58px;left:24px;width:76px">预览</span>
  </span>
</div>
</div>
<div class="hud-wrap" id="hudWrap" style="position:absolute;left:0;top:0">
  <button class="study-chip" id="studyChip" type="button">
    <svg class="study-ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="study-ring-track" cx="10" cy="10" r="8"></circle><circle class="study-ring-fill" id="ringFill" cx="10" cy="10" r="8" pathLength="1" transform="rotate(-90 10 10)"></circle></svg>
    <span class="study-seconds" id="studySeconds">记住 3s</span>
  </button>
  <div class="hud-row"><div class="hud"><span class="hud-value">00:00</span></div></div>
</div>
</div>
<div class="modal" id="modalProbe" style="width:340px">
  <p class="modal-timed-out" id="timedOut">Out of time</p>
  <div class="modal-actions">
    <button class="secondary-button" type="button">Save</button>
    <button class="text-button" id="textAction" type="button">Copy</button>
  </div>
</div>
<div id="launcherProbe" style="width:540px">
<header class="launcher-head">
  <div class="brand"><span class="brand-mark"><span class="brand-mark-glyph">?</span></span>
    <div class="brand-text"><strong class="brand-name">Flip Your Desk</strong><span class="brand-tagline" id="tagline">A memory game played on your own desktop icons</span></div></div>
  <div class="head-spacer"></div>
  <div class="head-actions" id="headActions">
    <button class="icon-button lang-button" id="langBtn" type="button">中文</button>
    <button class="icon-button" type="button">M</button>
    <button class="icon-button" type="button">-</button>
    <button class="icon-button" type="button">X</button>
  </div>
</header>
</div>
</body></html>`;
}

const dir = mkdtempSync(join(tmpdir(), "fyd-ui-"));
const file = join(dir, "scene.html");
writeFileSync(file, scene());
const sceneUrl = `file:///${file.split("\\").join("/")}`;
const PORT = 9400 + (process.pid % 500);
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--force-device-scale-factor=1", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(dir, "profile")}`, "--window-size=800,400", "about:blank",
], { stdio: "ignore" });

let ws;
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

/** 每次 DOM 断言都重新导航，保证 3D 动画从头播放、样式全新生效。 */
async function fresh(expression) {
  await send("Page.navigate", { url: sceneUrl });
  await send("Runtime.evaluate", {
    expression: `new Promise((resolve) => {
      const ready = () => {
        const card = document.querySelector('.card');
        if (card && getComputedStyle(card).position === 'absolute' &&
            document.styleSheets.length > 0) resolve(true);
        else requestAnimationFrame(ready);
      };
      ready();
    })`,
    awaitPromise: true,
  });
  return evaluate(expression);
}

async function start() {
  let version;
  for (let i = 0; i < 60; i++) {
    try {
      version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!version) throw new Error("Edge CDP 未就绪");
  const page = await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(sceneUrl)}`,
    { method: "PUT" },
  ).then((r) => r.json());
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  await send("Runtime.enable");
  await send("Page.enable");
}

async function stop() {
  try { ws?.close(); } catch { /* 已关闭 */ }
  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 20; i++) {
    try { rmSync(dir, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("卡背与透明卡面占据相同尺寸", async () => {
  const rects = await fresh(`(() => {
    const back = document.getElementById('back');
    const face = document.getElementById('face');
    const backInner = document.querySelector('.card-back-inner');
    const faceInner = document.querySelector('.is-photo');
    // offset 是布局尺寸，不受 3D 翻转中途的投影影响。
    return { back: [back.offsetWidth, back.offsetHeight],
             face: [face.offsetWidth, face.offsetHeight],
             backInner: [backInner.offsetWidth, backInner.offsetHeight],
             faceInner: [faceInner.offsetWidth, faceInner.offsetHeight] };
  })()`);
  assert.deepEqual(rects.back, [76, 100], "卡背外框应为整格");
  assert.deepEqual(rects.face, [76, 100], "卡面外框应为整格");
  assert.deepEqual(rects.backInner, rects.faceInner, "两面可见盒必须同尺寸");
});

test("翻出的透明卡面有可见的卡身份边缘（不遮挡图标）", async () => {
  const info = await fresh(`(() => {
    const inner = document.querySelector('.is-photo');
    const cs = getComputedStyle(inner, '::after');
    const img = document.querySelector('.face-image');
    return { edge: [cs.content, cs.borderTopWidth, cs.boxShadow, cs.backgroundImage],
             imageBox: [img.offsetWidth, img.offsetHeight] };
  })()`);
  const hasEdge = info.edge.some((v) => v && v !== "none" && v !== "normal" && v !== "0px");
  assert.ok(hasEdge, "透明卡面需要有边缘身份层（伪元素描边/发光）");
  assert.deepEqual(info.imageBox, [76, 100], "边缘层不得改变图标画布尺寸");
});

test("3D 翻转：两面共享透视容器且正面初始不可见", async () => {
  const info = await fresh(`(() => {
    const face = document.querySelector('.is-photo');
    const cs = getComputedStyle(face);
    return { backface: cs.backfaceVisibility, transform: cs.transform };
  })()`);
  assert.equal(info.backface, "hidden", "正面需要 backface-visibility:hidden");
  assert.notEqual(info.transform, "none", "正面初始应旋转 180° 隐藏");
});

test("3D 翻转：卡面创建后动画自动转到 0° 可见", async () => {
  const info = await fresh(`(async () => {
    await new Promise((r) => setTimeout(r, 400));
    const inner = document.querySelector('.is-photo');
    return { transform: getComputedStyle(inner).transform,
             animation: getComputedStyle(inner).animationName };
  })()`);
  assert.match(info.animation, /card-flip-3d-in/, "翻牌应由 3D 翻转动画驱动");
  assert.match(info.transform, /^(matrix3d\(1, 0, 0, 0, 0, 1|matrix\(1, 0, 0, 1, 0, 0\))/, "动画结束正面应为 0°");
});

test("覆盖层空白区不吃桌面点击，只有卡片可交互", async () => {
  const info = await fresh(`(() => ({
    root: getComputedStyle(document.querySelector('.overlay-root')).pointerEvents,
    board: getComputedStyle(document.querySelector('.board')).pointerEvents,
    card: getComputedStyle(document.getElementById('back')).pointerEvents,
  }))()`);
  assert.equal(info.root, "none", "覆盖层根元素必须穿透");
  assert.equal(info.board, "none", "牌桌层必须穿透");
  assert.equal(info.card, "auto", "卡片本身必须可点击");
});

test("致命弹窗居中、有遮罩、且文案走本地化（非硬编码英文）", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const fatal = source.slice(source.indexOf("export function renderFatal"));
  assert.match(fatal, /modal-layer/, "致命弹窗必须包在 .modal-layer 里");
  assert.match(fatal, /\bt\(/, "标题与按钮必须走 t()");
  assert.doesNotMatch(fatal, /"Quit"|"Flip Your Desk"/, "不得残留硬编码英文文案");
});

test("每个后端错误码在两种语言里都有文案", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/platform/windows.rs"), "utf8")
    + readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8")
    + readFileSync(join(ROOT, "src-tauri/src/game.rs"), "utf8");
  const codes = new Set(
    [...rust.matchAll(/AppError::(?:new|with_detail)\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
  );
  const zh = readFileSync(join(ROOT, "src/locales/zh-CN.ts"), "utf8");
  const en = readFileSync(join(ROOT, "src/locales/en-US.ts"), "utf8");
  const missing = [...codes].filter((code) =>
    !zh.includes(`"error.${code}"`) || !en.includes(`"error.${code}"`));
  assert.deepEqual(missing, [], `缺少字典的错误码: ${missing.join(", ")}`);
});

test("音效：主增益 + 限幅 + 静音立即打断已排期的音", () => {
  const source = readFileSync(join(ROOT, "src/audio.ts"), "utf8");
  assert.match(source, /DynamicsCompressor/, "需要限幅器防止多音叠加削顶");
  assert.match(source, /master/, "需要主增益节点统一控制音量");
  assert.match(source, /localStorage/, "静音偏好必须持久化");
  assert.match(
    methodBody(source, "setMuted"),
    /linearRamp|setValueAtTime/,
    "静音要立刻把主增益降到 0",
  );
});

test("翻牌音与画面同帧：不能在 drawCard 的 .then() 里晚于 state-changed", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  assert.doesNotMatch(source, /drawCard\([\s\S]{0,160}sounds\.flip\(\)/,
    "翻牌音应由 state-changed 里新出现的正面驱动");
});

test("小按钮的命中区不小于 44×44（用伪元素扩大，视觉尺寸不变）", () => {
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  for (const selector of [".icon-button", ".hud-button", ".confirm-button", ".secondary-button", ".study-chip"]) {
    assert.match(css, new RegExp(`${selector.replace(".", "\\.")}::before`), `${selector} 需要透明伪元素扩大命中区`);
  }
  assert.match(css, /width: 44px;\s*height: 44px;/, "命中区至少 44×44");
});

test("主按钮 focus 环使用高对比色，不用深色 ink", () => {
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  const block = css.slice(css.indexOf(".primary-button:focus-visible"));
  assert.doesNotMatch(block.slice(0, 300), /--accent-ink/, "focus 环不能是 #1d1405");
});

test("reduced-motion 全局覆盖且无冗余块", () => {
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)/g)];
  assert.equal(blocks.length, 1, "只保留一个全局 reduced-motion 规则块");
  assert.match(css, /animation-duration: 0\.01ms !important/, "全局压掉动画时长");
});

test("HUD 与模态层在穿透的根容器里仍可交互", () => {
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  for (const selector of [".hud-wrap", ".modal-layer"]) {
    const escaped = selector.replace(".", "\\.");
    const block = (css.match(new RegExp(`${escaped}[^{}]*\\{[^}]*\\}`, "s")) ?? [""])[0];
    assert.match(block, /pointer-events:\s*auto/, `${selector} 必须显式恢复 pointer-events:auto`);
  }
  const toast = (css.match(/\.toast\s*\{[^}]*\}/s) ?? [""])[0];
  assert.match(toast, /pointer-events:\s*none/, "toast 只是提示，不该拦截桌面点击");
});

test("选中/拖放金框画在格内，不与相邻卡片重叠", () => {
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  const block = (css.match(/\.card\.is-drop-target[^{]*\{[^}]*\}/s) ?? [""])[0];
  assert.match(block, /outline-offset:\s*-2px/, "金框必须内缩，外描边会和邻卡压在一起");
  assert.doesNotMatch(block, /outline-offset:\s*[1-9]/, "不能再向外偏移");
  assert.match(block, /border-radius:\s*12px/, "内描边圆角要与卡面一致");
});

test("拖拽落点与悬停高亮同源：finishDrag 不再重新 hitTest", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const finish = source.slice(source.indexOf("private finishDrag"), source.indexOf("private globalPoint"));
  assert.doesNotMatch(finish, /this\.hitTest\(/, "松手必须沿用 hoverSlot（所见即所得），不能二次 hitTest");
  assert.match(finish, /drag\.hoverSlot/, "落点必须来自悬停高亮槽位");
});

test("拖拽结束后清除悬停高亮，不留金框", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const finish = source.slice(source.indexOf("private finishDrag"), source.indexOf("private globalPoint"));
  assert.match(finish, /applyHover\(null\)/, "松手后必须清掉 is-drop-target 残留");
});

test("拖拽后的 click 被抑制，不会触发第二次换位", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const finish = source.slice(source.indexOf("private finishDrag"), source.indexOf("private globalPoint"));
  assert.match(finish, /suppressClick/, "armed 拖拽结束后必须抑制随后的 click");
  const click = source.slice(source.indexOf("private onFaceClick"));
  assert.match(click, /suppressClick/, "onFaceClick 入口必须检查抑制标志");
});

test("换位后选中态跟随图标的新槽位，不用过期槽位发起交换", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const apply = source.slice(source.indexOf("private applyState"));
  assert.match(
    apply,
    /iconSlot\.get\(this\.selectedIcon\)/,
    "applyState 必须把 selectedSlot 同步到被选图标当前所在槽位",
  );
});

test("pointercancel 走中断弹回，不提交换位", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const bind = source.slice(
    source.indexOf("private bindDragListeners"),
    source.indexOf("private unbindDragListeners"),
  );
  assert.match(bind, /addEventListener\("pointercancel", cancel/, "系统取消必须按中断处理");
  assert.doesNotMatch(bind, /addEventListener\("pointercancel", end/, "不得带事件提交换位");
});

test("新手势开始时复位 click 抑制，并拒绝并发拖拽", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const down = source.slice(
    source.indexOf("private onPointerDown"),
    source.indexOf("private bindDragListeners"),
  );
  assert.match(down, /this\.suppressClick = false/, "pointerdown 必须复位 suppressClick");
  assert.match(down, /if \(this\.drag\) return/, "已有拖拽时必须拒绝第二个 pointerdown");
});

// ---------------------------------------------------------- 材质化音效（Area 1）

/** 取 TS 类方法体：从方法名到下一个两空格缩进的闭大括号。 */
function methodBody(source, name) {
  const start = source.indexOf(`${name}(`);
  if (start < 0) return "";
  const end = source.indexOf("\n  }", start);
  return end < 0 ? "" : source.slice(start, end);
}

test("音效材质化：flip/pickup/drop 每次播放有 ±4% 随机音高微变", () => {
  const source = readFileSync(join(ROOT, "src/audio.ts"), "utf8");
  assert.match(source, /humanize\(\):\s*number/, "需要 humanize 随机倍率助手");
  for (const name of ["flip", "pickup", "drop"]) {
    const body = methodBody(source, name);
    assert.ok(body.includes("humanize"), `${name}() 必须用 humanize 做随机音高`);
  }
});

test("音效材质化：落卡 = 低频冲击 + lowpass 呢面摩擦尾", () => {
  const source = readFileSync(join(ROOT, "src/audio.ts"), "utf8");
  const body = methodBody(source, "drop");
  assert.match(body, /"lowpass"/, "落卡需要 lowpass 摩擦尾（呢面质感）");
  assert.match(body, /tone\(/, "落卡需要低频冲击音");
});

test("音效材质化：pickup 是纸面摩擦（带通噪声扫频），不是单音哔声", () => {
  const source = readFileSync(join(ROOT, "src/audio.ts"), "utf8");
  const body = methodBody(source, "pickup");
  assert.match(body, /noise\(/, "拿起应使用噪声摩擦");
  assert.match(body, /\d{3,4}.*\d{3,4}/s, "摩擦应有起止频率（扫频）");
});

test("发牌 tick：dealTick 声部存在，deal 节流间隔短于通用 40ms", () => {
  const source = readFileSync(join(ROOT, "src/audio.ts"), "utf8");
  assert.match(source, /dealTick\(\): void/, "需要 dealTick 声部");
  assert.match(source, /MIN_INTERVALS[^;]*deal:\s*(\d+)/, "deal 需要专用节流间隔");
  const interval = Number(source.match(/MIN_INTERVALS[^;]*deal:\s*(\d+)/)?.[1]);
  assert.ok(interval < 40, `deal 间隔 ${interval}ms 必须小于通用 40ms`);
});

// ---------------------------------------------------------- 卡背扑克化（Area 2）

test("卡背扑克化：内嵌细线框（::after，1px 描边，inset ≥3px）", async () => {
  const info = await fresh(`(() => {
    const cs = getComputedStyle(document.querySelector('.card-back-inner'), '::after');
    return { content: cs.content, width: cs.borderTopWidth, style: cs.borderTopStyle,
             top: cs.top, left: cs.left };
  })()`);
  assert.equal(info.content, '""', "内框必须是伪元素画的");
  assert.equal(info.width, "1px", "框线 1px");
  assert.notEqual(info.style, "none", "框线样式不能为 none");
  assert.match(info.top, /^[3-9](\.\d+)?px$/, `内框 inset 应在 3-9px，实际 ${info.top}`);
});

test("卡背扑克化：四角圆点存在且不拦截指针", async () => {
  const info = await fresh(`(() => {
    const cs = getComputedStyle(document.querySelector('.card-back-inner'), '::before');
    const matches = cs.backgroundImage.match(/radial-gradient/g) ?? [];
    return { count: matches.length, pointer: cs.pointerEvents };
  })()`);
  assert.ok(info.count >= 4, `四角圆点需要 4 个 radial-gradient，实际 ${info.count}`);
  assert.equal(info.pointer, "none", "装饰层不得拦截指针");
});

test("卡背扑克化：深浅 tone 各有内框配色", () => {
  // vite 压缩会去掉属性选择器值的引号：data-tone="light" → data-tone=light
  assert.match(cssText, /\.card\[data-tone="?light"?\] \.card-back-inner::?after/, "浅色卡背要有内框配色变体");
});

// ---------------------------------------------------------- 错误 shake（Area 3）

test("错误反馈：API 失败对涉事卡 shake，用 WAAPI 叠加合成（不替换 3D 翻转动画）", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const shake = methodBody(source, "private shake");
  assert.match(shake, /animate\(/, "shake 需要元素动画");
  assert.match(shake, /composite:\s*"add"/,
    "必须叠加合成：替换式 CSS 动画会顶掉 face 靠 forwards 撑住的 rotateY 基线，卡面会隐身");
  const calls = source.match(/this\.shake\(/g) ?? [];
  assert.ok(calls.length >= 4,
    `抽牌/拖拽/键盘换位四条失败路径都要 shake（实际 ${calls.length} 处）`);
});

test("错误反馈：shake 跳过 reduced-motion 用户", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const shake = methodBody(source, "private shake");
  assert.match(shake, /prefers-reduced-motion/, "shake 必须检查 reduced-motion 并跳过");
});

// ---------------------------------------------------------- 发牌级联（Area 4）

test("发牌级联：buildBoard 按 y/x 排序逐卡延迟，延迟只在首建路径", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const build = methodBody(source, "private buildBoard");
  assert.match(build, /sort\(/, "发牌要按位置排序（先 y 后 x，像发牌员摆牌）");
  assert.match(build, /backwards/, "延迟期间卡背必须用 fill backwards 保持隐形");
  const ensure = methodBody(source, "private ensureBack");
  assert.doesNotMatch(ensure, /backwards|animationDelay/,
    "中途盖回（applyState 调 ensureBack）不得带延迟，否则换位后卡背凭空消失一拍");
});

test("发牌级联：dealTick 只在主屏播、reduced-motion 跳过、销毁时清理定时器", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const build = methodBody(source, "private buildBoard");
  assert.match(build, /isPrimary/, "发牌音只在主屏播，避免多显示器叠声");
  assert.match(build, /prefers-reduced-motion/, "reduced-motion 必须跳过级联");
  const destroyStart = source.indexOf("destroy(): void");
  const destroy = source.slice(destroyStart, source.indexOf("\n  }", destroyStart));
  assert.match(destroy, /dealTimers/, "销毁时必须清理发牌定时器");
});

// ---------------------------------------------------------- 手感闭环（Area 5）

/** 提取 CSS 文本中从 startMarker 起的完整规则块（括号配平）。 */
function cssBlock(text, startMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) return "";
  let depth = 0;
  let i = text.indexOf("{", start);
  const begin = i;
  for (; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

test("翻牌弧线：翻转中途放大（keyframes 中段 scale >1），时长 320ms", () => {
  const block = cssBlock(cssText, "@keyframes card-flip-3d-in");
  assert.ok(block, "keyframes 必须存在");
  assert.match(block, /scale\(1\.0[4-9]/, "翻转中段要有 scale >1 的抛物线弧");
  // vite 压缩会把 320ms 缩写成 .32s，两种形式都接受
  assert.match(cssText, /card-flip-3d-in (\.\d+s|320ms)/, "翻牌时长 320ms");
});

test("拖拽倾斜：跟随速度微倾斜且有 ±3° clamp，归位 transform 不残留旋转", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const move = methodBody(source, "private onPointerMove");
  assert.match(move, /rotate\(/, "拖动中 transform 要组合 rotate");
  assert.match(move, /Math\.max\(-3/, "倾斜必须有 -3° 下限");
  assert.match(move, /Math\.min\(3/, "倾斜必须有 +3° 上限");
  const finish = methodBody(source, "private finishDrag");
  assert.doesNotMatch(finish, /rotate\(/, "归位 transform 不得残留 rotate");
});

test("落卡回弹：成功落卡播 120ms settle（叠加合成 + reduced-motion 跳过）", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const settle = methodBody(source, "private settle");
  assert.match(settle, /animate\(/, "settle 需要元素动画");
  assert.match(settle, /composite:\s*"add"/, "settle 必须叠加合成，理由同 shake");
  assert.match(settle, /prefers-reduced-motion/, "settle 必须跳过 reduced-motion");
  const finish = methodBody(source, "private finishDrag");
  assert.match(finish, /this\.settle\(/, "成功落卡路径要调 settle");
});

// ---------------------------------------------------------- 启动窗微打磨（Area 6）

test("启动窗微打磨：brand 卡牌 hover 摆正、窗口淡入、次级按钮有 active 态", () => {
  assert.match(cssText, /\.brand:hover \.brand-mark/, "brand 卡牌 hover 摆正");
  assert.match(cssText, /launcher-in/, "启动窗要有淡入动画");
  assert.ok(cssBlock(cssText, ".secondary-button:active"), "secondary-button 需要 active 态");
  assert.ok(cssBlock(cssText, ".text-button:active"), "text-button 需要 active 态");
});

// ---------------------------------------------------------- P1 模糊对焦 + P3 复制结算

test("卡背静止态无实时模糊（CSSOM 实测）", async () => {
  const info = await fresh(`(() => ({
    blur: getComputedStyle(document.querySelector('.card-back-inner')).backdropFilter,
  }))()`);
  assert.equal(info.blur, "none",
    "静止卡背 computed backdrop-filter 必须为 none——数十层实时模糊是发牌/拖拽掉帧主因");
});

test("卡背模糊只在被触碰时对焦：hover/拖拽规则带 blur，.card-inner 过渡包含 backdrop-filter", () => {
  assert.match(cssText, /\.card-back:hover \.card-back-inner[^{]*\{[^}]*backdrop-filter/,
    "hover 单卡升级 blur（拿起才对焦）");
  assert.match(cssText, /\.card-back\.is-dragging \.card-back-inner[^{]*\{[^}]*backdrop-filter/,
    "拖拽单卡升级 blur");
  assert.match(cssText, /transition:[^{}]*backdrop-filter/,
    "blur 切换要有过渡（命名属性，不得 transition:all）");
});

test("复制结算：剪贴板优先 navigator.clipboard，失败退回 execCommand，文案全走 i18n", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const show = source.slice(source.indexOf("private showResult"), source.indexOf("private showBusy"));
  assert.match(show, /navigator\.clipboard\.writeText/, "优先 navigator.clipboard");
  assert.match(show, /execCommand\("copy"\)/, "WebView2 拒绝时退回 execCommand 兜底");
  assert.match(show, /result\.copy/, "按钮文案走 i18n");
  assert.match(show, /result\.shareLine/, "分享行走 i18n 模板");
  const zh = readFileSync(join(ROOT, "src/locales/zh-CN.ts"), "utf8");
  const en = readFileSync(join(ROOT, "src/locales/en-US.ts"), "utf8");
  for (const key of ["result.copy", "result.copied", "result.copyFailed", "result.shareLine"]) {
    assert.ok(zh.includes(`"${key}"`), `zh 缺 ${key}`);
    assert.ok(en.includes(`"${key}"`), `en 缺 ${key}`);
  }
});

test("开局进度：launcher 订阅 capture-progress 并显示 n/N", () => {
  const source = readFileSync(join(ROOT, "src/launcher.ts"), "utf8");
  assert.match(source, /listen[<(]/, "launcher 需要 listen 导入");
  assert.match(source, /capture-progress/, "订阅 capture-progress 事件");
  assert.match(source, /launcher\.dealing/, "进度文案走 i18n");
  const zh = readFileSync(join(ROOT, "src/locales/zh-CN.ts"), "utf8");
  const en = readFileSync(join(ROOT, "src/locales/en-US.ts"), "utf8");
  for (const f of [zh, en]) {
    assert.ok(f.includes('"launcher.dealing"'), "dealing key 存在");
  }
});

test("Fences 提示：organizerDetected 非阻塞，文案双语就位", () => {
  const source = readFileSync(join(ROOT, "src/launcher.ts"), "utf8");
  assert.match(source, /organizerDetected/, "launcher 渲染 organizerDetected");
  const zh = readFileSync(join(ROOT, "src/locales/zh-CN.ts"), "utf8");
  const en = readFileSync(join(ROOT, "src/locales/en-US.ts"), "utf8");
  for (const f of [zh, en]) {
    assert.ok(f.includes('"launcher.organizerTitle"'), "organizerTitle key 存在");
    assert.ok(f.includes('"launcher.organizerHint"'), "organizerHint key 存在");
  }
  const rust = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
  assert.match(rust, /detect_desktop_organizers/, "后端探测已接线");
  const model = readFileSync(join(ROOT, "src-tauri/src/model.rs"), "utf8");
  assert.match(model, /organizer_detected/, "EnvReport 含 organizer_detected");
});

test("PresenceController: 只做空闲计时、不碰 DOM、可 dispose", () => {
  const f = readFileSync(join(ROOT, "src/presence.ts"), "utf8");
  assert.match(f, /export class PresenceController/, "导出 PresenceController");
  assert.match(f, /onIdle\?:/, "构造参数含 onIdle");
  assert.ok(!/onHide|onShow/.test(f), "不再有盖牌回调（C1 已下线）");
  assert.match(f, /resetIdle\(\)/, "暴露 resetIdle");
  assert.match(f, /dispose\(\)/, "暴露 dispose");
  assert.match(f, /addEventListener\("visibilitychange"/, "监听 visibilitychange");
  assert.ok(!/addEventListener\("blur"/.test(f), "不再监听 blur（focusable(false) 下不可靠）");
  assert.ok(!/querySelector|classList|createElement|appendChild/.test(f), "PresenceController 不操作 DOM");
  assert.match(f, /IDLE_MS\s*=\s*8000/, "空闲阈值常量为 8000ms");
});

test("PresenceController 行为：到点触发一次 onIdle，dispose 后不再触发", async () => {
  const out = await tsBehaviorTest("src/presence.ts", `
    let fired = 0;
    const c = new PresenceController({ onIdle: () => { fired++; }, idleMs: 40 });
    return new Promise((resolve) => setTimeout(() => {
      const before = fired;
      c.dispose();
      setTimeout(() => resolve({ before, after: fired }), 120);
    }, 120));
  `);
  assert.equal(out.before, 1, "空闲到点触发一次 onIdle");
  assert.equal(out.after, 1, "dispose 后不再触发");
});

test("呼吸/退出仪式：类规则能压过内联 card-in 入场动画", async () => {
  const out = await fresh(`(() => {
    const back = document.getElementById('back');
    const inner = document.getElementById('backInner');
    back.classList.add('revealing');
    const reveal = getComputedStyle(inner).animationName;
    back.classList.remove('revealing');
    back.classList.add('breathing');
    const breathe = getComputedStyle(inner).animationName;
    return { reveal, breathe };
  })()`);
  assert.equal(out.reveal, "card-reveal", "revealing 真的播翻回动画");
  assert.equal(out.breathe, "card-breathe", "breathing 真的播起伏动画");
});

/** 在 CDP 页面里执行真源码：用 typescript 把 .ts 转译掉类型，去掉 export 后注入。
 *  被测模块只依赖 window/document、无 import，可直接这样跑真实实现而非复制品。 */
async function tsBehaviorTest(relPath, expression) {
  const tsSource = readFileSync(join(ROOT, relPath), "utf8");
  const js = ts.transpileModule(tsSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/export /g, "");
  return fresh(`(() => {
    ${js}
    ${expression}
  })()`);
}

test("ExitChoreography 行为：cancel 后 then 绝不执行、逐卡类被清干净", async () => {
  const out = await tsBehaviorTest("src/choreography.ts", `
    const _mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => q.includes('prefers-reduced-motion')
      ? { matches: false, media: q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, onchange: null, dispatchEvent(){ return false; } }
      : _mm(q);
    const card = document.getElementById('back');
    let fired = 0;
    const c = new ExitChoreography([card]);
    c.play(() => { fired++; });
    c.cancel();
    return new Promise((resolve) => setTimeout(() => resolve({
      fired,
      revealing: card.classList.contains('revealing'),
    }), 1200));
  `);
  assert.equal(out.fired, 0, "cancel 阻止 then");
  assert.equal(out.revealing, false, "逐卡 timer 清干净，类没被加回来");
});

test("ExitChoreography 行为：动画演完 then 执行一次", async () => {
  const out = await tsBehaviorTest("src/choreography.ts", `
    const card = document.getElementById('back');
    let fired = 0;
    const c = new ExitChoreography([card]);
    c.play(() => { fired++; });
    return new Promise((resolve) => setTimeout(() => resolve({ fired }), 1200));
  `);
  assert.equal(out.fired, 1, "then 由完成回调执行且只一次");
});

test("ExitChoreography 排期：40 张牌的最后一张也留足 320ms 翻回", async () => {
  const out = await tsBehaviorTest("src/choreography.ts", `
    const _mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => q.includes('prefers-reduced-motion')
      ? { matches: false, media: q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, onchange: null, dispatchEvent(){ return false; } }
      : _mm(q);
    const cards = Array.from({ length: 40 }, () => document.createElement('div'));
    const started = performance.now();
    let lastAdd = -1;
    for (const card of cards) {
      const add = card.classList.add.bind(card.classList);
      card.classList.add = (cls) => {
        if (cls === 'revealing') lastAdd = performance.now() - started;
        return add(cls);
      };
    }
    const c = new ExitChoreography(cards);
    c.play(() => {});
    const lastOffset = (cards.length - 1) * c.perCard;
    return new Promise((resolve) => {
      const deadline = performance.now() + 2000;
      const poll = () => {
        if (lastAdd >= 0 || performance.now() > deadline) {
          return resolve({ lastAdd, lastOffset });
        }
        setTimeout(poll, 20);
      };
      poll();
    });
  `);
  assert.ok(out.lastAdd >= 0, "最后一张确实被加上 revealing");
  // 旧公式 1000/40 会让最后一张 975ms 才起演；新排期按 (1000-320)/39≈17.44ms，末张约 680ms。
  assert.ok(out.lastOffset < 800, `最后一张排期 ${out.lastOffset.toFixed(0)}ms，需留足 320ms 翻回`);
});

test("动画期间 Esc 可取消（onKeyDown 不在 pending 时直接 return）", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const start = f.indexOf("private onKeyDown(");
  const end = f.indexOf("private trapFocus(");
  const block = f.slice(start, end);
  assert.match(block, /cancelExit\(\)/, "onKeyDown 有取消动画的分支");
  const guard = block.slice(0, block.indexOf("cancelExit()"));
  assert.ok(!/if \(this\.pending\) return;/.test(guard) || /cancelExit\(\)/.test(guard),
    "pending 时不是无条件 return（否则动画中 Esc 永远到不了取消）");
});

test("Esc 不再取消选卡：提示与逻辑都只给鼠标路径", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const block = f.slice(f.indexOf("private onKeyDown("), f.indexOf("private trapFocus("));
  assert.ok(!/clearSelection\(\)/.test(block), "Esc 分支不再清选中");
  assert.match(block, /this\.showExitConfirm\(\)/, "有选中卡时 Esc 仍可开退出确认");
  assert.doesNotMatch(block, /this\.selectedIcon === null/, "选中卡不再挡住退出确认");
  const zh = readFileSync(join(ROOT, "src/locales/zh-CN.ts"), "utf8");
  const en = readFileSync(join(ROOT, "src/locales/en-US.ts"), "utf8");
  assert.ok(!/overlay\.selected"[^\n]*Esc/.test(zh), "中文提示不再承诺 Esc 取消");
  assert.ok(!/overlay\.selected"[^\n]*Esc/.test(en), "英文提示不再承诺 Esc 取消");
  assert.match(zh, /再点一次取消/, "中文提示给出再点一次的取消路径");
  assert.match(en, /click it again to cancel/, "英文提示给出再点一次的取消路径");
});

test("退出仪式：三个按钮仍调原命令、runExit 内部零 IPC", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  assert.match(f, /new ExitChoreography/, "创建了编排器");
  assert.match(f, /api\.quitApp\(\)/, "退出仍调 quit_app");
  assert.match(f, /\.\s*restoreAndExit\(\)/, "回到原布局仍调 restoreAndExit");
  assert.match(f, /\.\s*saveAndExit\(\)/, "保存仍调 saveAndExit");
  const start = f.indexOf("private runExit(");
  const end = f.indexOf("private cancelExit()");
  const block = f.slice(start, end);
  assert.ok(!/api\.|invoke|emit/.test(block), "runExit 内部零 IPC");
});

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

test("启动窗 header：语言按钮与 tagline 不换行、按钮组不收缩", async () => {
  const out = await fresh(`(() => {
    const lang = document.getElementById('langBtn');
    const tagline = document.getElementById('tagline');
    const actions = document.getElementById('headActions');
    return {
      langH: Math.round(lang.getBoundingClientRect().height),
      taglineWS: getComputedStyle(tagline).whiteSpace,
      actionsShrink: getComputedStyle(actions).flexShrink,
    };
  })()`);
  assert.ok(out.langH <= 34, `语言按钮单行不竖排（实测高 ${out.langH}px）`);
  assert.equal(out.taglineWS, "nowrap", "tagline 单行，不再折成两行撑高头部");
  assert.equal(out.actionsShrink, "0", "按钮组不被压缩");
});

test("选中卡只有一圈金边：保留键盘路径，卡片不画焦点环", async () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const select = f.slice(f.indexOf("private selectIcon("), f.indexOf("private clearSelection("));
  assert.ok(select.includes('classList.add("is-selected")'), "选中仍加 is-selected 金边");
  assert.match(select, /element\.focus\(/, "保留 programmatic focus（覆盖窗 focusable(false)，Esc 退出确认仍需键盘路径）");
  const clear = f.slice(f.indexOf("private clearSelection("), f.indexOf("private commitSelection("));
  assert.ok(!/\.blur\(/.test(clear), "取消选中不 blur（保住覆盖窗的键盘输入）");

  const out = await fresh(`(() => {
    const face = document.getElementById('face');
    const inner = document.getElementById('faceInner');
    face.classList.add('is-selected');
    face.focus({ preventScroll: true });
    return {
      active: document.activeElement.id,
      cardOutline: getComputedStyle(face).outlineStyle,
      innerOutline: getComputedStyle(inner).outlineStyle,
    };
  })()`);
  assert.equal(out.active, "face", "选中卡拿到 DOM 焦点");
  assert.equal(out.cardOutline, "solid", `选中金框画在 .card 上（实测 ${out.cardOutline}）`);
  // 比较 outline-style 而不是 width：outline: none 时 Chrome 仍报初始宽度 3px。
  assert.equal(out.innerOutline, "none", `不再叠 :focus-visible 第二圈（实测 ${out.innerOutline}）`);
});

test("退出仪式在结算屏也生效：正面卡逐张翻走，取消可平滑转回", async () => {
  const out = await fresh(`(async () => {
    const face = document.getElementById('face');
    const inner = document.getElementById('faceInner');
    const before = getComputedStyle(inner).rotate;
    face.classList.add('revealing');
    await new Promise((r) => setTimeout(r, 450));
    const after = getComputedStyle(inner).rotate;
    const anim = getComputedStyle(inner).animationName;
    face.classList.remove('revealing');
    await new Promise((r) => setTimeout(r, 450));
    return { before, after, anim, restored: getComputedStyle(inner).rotate };
  })()`);
  assert.equal(out.before, "none", "正面卡初始不旋转");
  assert.equal(out.after, "y -180deg", "revealing 后翻到背面（露出真图标）");
  assert.equal(out.anim, "card-flip-3d-in", "入场动画未被替换，取消不会重播");
  assert.equal(out.restored, "none", "取消后平滑转回正面");
});

test("启动窗重渲染不重播入场淡入（切语言不闪透明）", () => {
  const f = readFileSync(join(ROOT, "src/launcher.ts"), "utf8");
  assert.match(f, /dataset\.rendered/, "记录了是否已渲染");
  assert.match(f, /if \(!firstRender\) shell\.style\.animation = "none"/, "二次渲染关掉入场动画");
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  assert.match(css, /\.launcher-shell\s*\{[^}]*animation: launcher-in/, "入场动画仍只在首次渲染生效");
});

// ---------------------------------------------------------- 审查修复回归

test("TimedClock：到期只触发一次，重开用新 startedAtMs 重新计时", async () => {
  const out = await tsBehaviorTest("src/timed.ts", `
    const c = new TimedClock();
    const start = c.tick(10000, 0, false, 1000);
    const end = c.tick(10000, 0, false, 11000);
    const again = c.tick(10000, 0, false, 11001);
    const replay = c.tick(10000, 20000, false, 20000);
    const synced = c.tick(10000, 30000, false, 31000);
    const finished = c.tick(10000, 30000, true, 32000);
    return {
      start: start.leftMs,
      expired: end.expired,
      expiredAgain: again.expired,
      replay: replay.leftMs,
      synced: synced.leftMs,
      finished: finished.leftMs,
    };
  `);
  assert.equal(out.start, 10000, "首帧显示完整时限");
  assert.equal(out.expired, true, "到点只触发一次");
  assert.equal(out.expiredAgain, false, "同一局不会重复结算");
  assert.equal(out.replay, 10000, "重开换 startedAtMs 后重新满时限");
  assert.equal(out.synced, 9000, "优先用后端共享起点");
  assert.equal(out.finished, 0, "结算后倒计时归零");
});

test("限时 HUD 使用共享 startedAtMs，不再依赖每窗本地起点", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  assert.match(f, /new TimedClock\(\)/, "overlay 使用可测试的 TimedClock");
  const clock = methodBody(f, "private updateClock");
  assert.match(clock, /state\.startedAtMs/, "倒计时锚点来自后端");
  assert.doesNotMatch(f, /timedStartedAt/, "移除每窗本地起点");
  assert.doesNotMatch(f, /timingOut/, "移除永不复位的 timingOut");
});

test("拖拽回原位/空白松手后仍抑制随后的 click", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const finish = f.slice(f.indexOf("private finishDrag"), f.indexOf("private globalPoint"));
  assert.match(finish, /this\.suppressClick = true/, "armed 拖拽结束必须抑制 click");
  const afterTarget = finish.slice(finish.indexOf("const target ="));
  assert.doesNotMatch(
    afterTarget,
    /suppressClick = false/,
    "不能在 pointerup 内提前清抑制，否则回原位松手会误选中/交换",
  );
});

test("unbindDragListeners 用 cancel 解绑 pointercancel", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const block = f.slice(
    f.indexOf("private unbindDragListeners"),
    f.indexOf("private onPointerMove"),
  );
  assert.match(
    block,
    /removeEventListener\("pointercancel", listeners\.cancel/,
    "解绑必须与绑定的 cancel 处理器配对",
  );
});

test("结算时收起选中金框", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const apply = f.slice(f.indexOf("private applyState"), f.indexOf("private updateHud"));
  assert.match(apply, /if \(state\.finished\) this\.clearSelection\(\)/);
});

test("取消选中后重新摆放 HUD（提示条不再把胶囊留在半空）", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const clear = f.slice(f.indexOf("private clearSelection"), f.indexOf("private commitSelection"));
  assert.match(clear, /this\.placeFloating\(\)/);
});

test("拖拽命中排除 HUD/确认按钮", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const hit = f.slice(f.indexOf("private hitTest"), f.indexOf("private applyHover"));
  assert.match(hit, /hudWrap\.getBoundingClientRect\(\)/);
  assert.match(hit, /return null/);
});

test("i18n 替换用函数，图标名含 $& 不会被当成替换模式", () => {
  const f = readFileSync(join(ROOT, "src/i18n.ts"), "utf8");
  assert.match(f, /replaceAll\(`\{\$\{name\}\}`,\s*\(\)\s*=>/, "必须使用函数替换");
});

test("字号下限 12px（DESIGN 硬约束）", () => {
  const sizes = [...cssText.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) =>
    Number(m[1]));
  const small = sizes.filter((size) => size < 12);
  assert.deepEqual(small, [], `仍有 ${small.length} 处小于 12px 的字号`);
});

test("步骤号使用亮金，避免 accent-deep 在深底上低于 4.5:1", () => {
  const block = cssBlock(cssText, ".howto-index");
  assert.match(block, /color:var\(--accent\)/);
});

test("44px 热区之间留出足够间距，不互相抢占", () => {
  const head = cssBlock(cssText, ".head-actions");
  assert.match(head, /gap:(1[6-9]|[2-9]\d)px/, "30px 按钮的间距至少 16px");
  assert.match(
    cssText,
    /\.hud-button\+\.hud-button\{[^}]*margin-left:(1[4-9]|[2-9]\d)px/,
    "24px 按钮中心距至少 44px",
  );
});

test("卡片常驻 will-change 只留给拖拽中的单卡", () => {
  const card = cssBlock(cssText, ".card{");
  assert.doesNotMatch(card, /will-change/, "整副牌不应常驻合成层");
  const dragging = cssBlock(cssText, ".card.is-dragging");
  assert.match(dragging, /will-change:transform/);
});

test("卡片键盘焦点有可见替代环，选中态不叠第二圈", () => {
  assert.match(
    cssText,
    /\.card:focus-visible:not\(\.is-selected\) \.card-inner\{[^}]*outline:2px solid var\(--accent\)/,
  );
});

test("结算文字动作/超时标记居中，toast 在模态之上", async () => {
  const out = await fresh(`(() => {
    const text = document.getElementById('textAction');
    const timed = document.getElementById('timedOut');
    return {
      justify: getComputedStyle(text).justifySelf,
      align: getComputedStyle(timed).textAlign,
    };
  })()`);
  assert.equal(out.justify, "center", "文字动作居中");
  assert.equal(out.align, "center", "超时标记居中");
  const toast = cssBlock(cssText, ".toast{");
  assert.match(toast, /z-index:100/, "toast 必须高于 modal-layer 的 90");
});

test("模态有 aria-labelledby，焦点可被读屏命名", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const show = f.slice(f.indexOf("private showResult"), f.indexOf("private copyText"));
  assert.match(show, /aria-labelledby/);
  const exit = f.slice(f.indexOf("private showExitConfirm"), f.indexOf("private hideExitConfirm"));
  assert.match(exit, /aria-labelledby/);
});

test("启动窗切静音立即持久化", () => {
  const launcher = readFileSync(join(ROOT, "src/launcher.ts"), "utf8");
  const audio = readFileSync(join(ROOT, "src/audio.ts"), "utf8");
  assert.match(audio, /export function storeMuted/);
  assert.match(launcher, /storeMuted\(state\.muted\)/);
});

test("启动窗探测失败时不再显示就绪/放行开始", () => {
  const f = readFileSync(join(ROOT, "src/launcher.ts"), "utf8");
  assert.match(f, /env\.issues\.length === 0 && !env\.probeError/);
  assert.match(f, /!!env\.probeError/);
  assert.match(f, /state\.env = null/);
});

test("版本号六处一致（package/tauri/Cargo/i18n/两份 README）", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const tauri = JSON.parse(
    readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"),
  ).version;
  const cargo = readFileSync(join(ROOT, "src-tauri/Cargo.toml"), "utf8")
    .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const i18n = readFileSync(join(ROOT, "src/i18n.ts"), "utf8")
    .match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1];
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const readmeEn = readFileSync(join(ROOT, "README.en.md"), "utf8");
  assert.equal(tauri, pkg, "tauri.conf.json 版本");
  assert.equal(cargo, pkg, "Cargo.toml 版本");
  assert.equal(i18n, pkg, "APP_VERSION 版本");
  assert.ok(readme.includes(`Desk_${pkg}_x64`), "README 安装包名");
  assert.ok(readmeEn.includes(`Desk_${pkg}_x64`), "README.en 安装包名");
});

test("每个启动器问题码都有双语标题与提示", () => {
  const rust =
    readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8") +
    readFileSync(join(ROOT, "src-tauri/src/platform/windows.rs"), "utf8");
  const codes = new Set(
    [...rust.matchAll(/issues\.push\("([a-z_]+)"(?:\.to_string\(\))?\)/g)].map((m) => m[1]),
  );
  const zh = readFileSync(join(ROOT, "src/locales/zh-CN.ts"), "utf8");
  const en = readFileSync(join(ROOT, "src/locales/en-US.ts"), "utf8");
  const missing = [...codes].filter(
    (code) =>
      !zh.includes(`"issue.${code}.title"`) ||
      !zh.includes(`"issue.${code}.hint"`) ||
      !en.includes(`"issue.${code}.title"`) ||
      !en.includes(`"issue.${code}.hint"`),
  );
  assert.deepEqual(missing, [], `缺少启动器问题文案: ${missing.join(", ")}`);
});

// ------------------------------------------------------- 记忆阶段（study）

test("studyTick：整段 / 中途 / 翻下窗口 / 晚加载共用同一锚点", async () => {
  const out = await tsBehaviorTest("src/study.ts", `
    const full = studyTick(13000, 3000, 320, 10000);
    const mid = studyTick(13000, 3000, 320, 11500);
    const near = studyTick(13000, 3000, 320, 12700);
    const edge = studyTick(13000, 3000, 320, 13000);
    const late = studyTick(13000, 3000, 320, 13500);
    return {
      full: [full.remainingMs, full.fraction, full.seconds, full.done, full.flipDelayMs, full.settleDelayMs],
      mid: [mid.remainingMs, mid.fraction, mid.seconds, mid.done, mid.flipDelayMs, mid.settleDelayMs],
      near: [near.remainingMs, near.fraction, near.seconds, near.done, near.flipDelayMs, near.settleDelayMs],
      edge: [edge.remainingMs, edge.fraction, edge.seconds, edge.done, edge.flipDelayMs, edge.settleDelayMs],
      late: [late.remainingMs, late.fraction, late.seconds, late.done, late.flipDelayMs, late.settleDelayMs],
    };
  `);
  assert.deepEqual(out.full, [3000, 1, 3, false, 2680, 3000], "开局：2.68s 后起翻、3s 时收尾");
  assert.deepEqual(out.mid, [1500, 0.5, 2, false, 1180, 1500], "中途按剩余比例收缩");
  assert.deepEqual(out.near, [300, 0.1, 1, false, 0, 300], "进入 320ms 窗口立即起翻，锚点收尾");
  assert.deepEqual(out.edge, [0, 0, 0, true, 0, 0], "到点即结束");
  assert.deepEqual(out.late, [0, 0, 0, true, 0, 0], "晚加载窗口不补演负数");
});

test("记忆阶段样式：预览不可点、圆环收缩、翻下转走", async () => {
  const out = await fresh(`(async () => {
    const chip = document.getElementById('studyChip');
    const preview = document.getElementById('preview');
    const inner = document.getElementById('previewInner');
    const fill = document.getElementById('ringFill');
    const hit = getComputedStyle(chip, '::before');
    const before = {
      peek: getComputedStyle(preview).pointerEvents,
      transform: getComputedStyle(inner).transform,
      anim: getComputedStyle(inner).animationName,
    };
    fill.style.strokeDashoffset = '1';
    preview.classList.add('is-flipping');
    await new Promise((r) => setTimeout(r, 450));
    return {
      ...before,
      hit: [hit.width, hit.height],
      stroke: getComputedStyle(fill).stroke,
      dash: getComputedStyle(fill).strokeDasharray,
      rotate: getComputedStyle(inner).rotate,
      opacity: getComputedStyle(inner).opacity,
    };
  })()`);
  assert.equal(out.peek, "none", "预览卡不吃指针事件");
  assert.equal(out.anim, "none", "预览不播 card-flip-3d-in 入场翻转");
  assert.match(
    out.transform,
    /^(none|matrix\(1, 0, 0, 1, 0, 0\)|matrix3d\(1, 0, 0, 0, 0, 1)/,
    "预览直接正面朝上",
  );
  assert.deepEqual(out.hit, ["44px", "44px"], "跳过按钮有 44×44 命中区");
  assert.match(out.stroke, /230, 180, 91/, "圆环用金色 accent");
  assert.equal(out.dash, "1px", "pathLength=1 让 dashoffset 直接表示剩余比例");
  assert.equal(out.rotate, "y -180deg", "翻下把卡面转走");
  assert.equal(out.opacity, "0", "翻下后预览不再遮住卡背");
});

test("记忆阶段：真实布局预览 + 输入锁 + 跳过与收尾都可达", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  assert.match(f, /studyTick\(/, "圆环由纯函数驱动");
  assert.match(f, /this\.icons\.get\(slot\.id\)/, "槽位 id 即原始图标 id，预览即真实布局");
  assert.match(f, /this\.board\.inert = true/, "记忆阶段锁住整块牌桌");
  assert.match(f, /this\.scheduleStudy\(\)/, "起翻按锚点一次性排期");
  assert.match(f, /tick\.flipDelayMs/, "起翻延迟由纯函数给出");
  assert.match(f, /tick\.settleDelayMs/, "收尾按正式起点");
  assert.doesNotMatch(
    methodBody(f, "private beginFlipDown"),
    /\+\s*40/,
    "不得再给收尾加固定 40ms 余量",
  );
  assert.match(f, /api\.skipStudy\(\)/, "跳过走独立命令");
  for (const [name, slice] of [
    ["runExit", f.slice(f.indexOf("private runExit("), f.indexOf("private cancelExit"))],
    ["destroy", methodBody(f, "  destroy")],
  ]) {
    assert.match(slice, /this\.endStudy\(\)/, `${name} 必须收掉预览与定时器`);
  }
  const rust = readFileSync(join(ROOT, "src-tauri/src/game.rs"), "utf8");
  assert.match(rust, /pub const FLIP_MS: u64 = 320/, "翻下过渡由后端定义");
  assert.match(rust, /flip_ms: FLIP_MS/, "翻下时长随状态下发");
  const model = readFileSync(join(ROOT, "src-tauri/src/model.rs"), "utf8");
  assert.match(model, /pub flip_ms: u64/);
  const types = readFileSync(join(ROOT, "src/types.ts"), "utf8");
  assert.match(types, /flipMs: number/);
});

test("记忆阶段文案中英齐备", () => {
  const zh = readFileSync(join(ROOT, "src/locales/zh-CN.ts"), "utf8");
  const en = readFileSync(join(ROOT, "src/locales/en-US.ts"), "utf8");
  for (const key of ["overlay.study", "overlay.studySkip", "overlay.studyAria"]) {
    assert.ok(zh.includes(`"${key}"`), `中文缺 ${key}`);
    assert.ok(en.includes(`"${key}"`), `英文缺 ${key}`);
  }
});

let failed = 0;
try {
  await start();
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`PASS ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${t.name}\n     ${err.message.split("\n")[0]}`);
    }
  }
} finally {
  await stop();
}
process.exit(failed ? 1 : 0);
