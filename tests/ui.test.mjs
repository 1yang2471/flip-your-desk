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
</div></div>
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
    + readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
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
  assert.match(source, /setMuted[\s\S]{0,300}linearRamp|setMuted[\s\S]{0,300}setValueAtTime/, "静音要立刻把主增益降到 0");
});

test("翻牌音与画面同帧：不能在 drawCard 的 .then() 里晚于 state-changed", () => {
  const source = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  assert.doesNotMatch(source, /drawCard\([\s\S]{0,160}sounds\.flip\(\)/,
    "翻牌音应由 state-changed 里新出现的正面驱动");
});

test("小按钮的命中区不小于 44×44（用伪元素扩大，视觉尺寸不变）", () => {
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  for (const selector of [".icon-button", ".hud-button", ".confirm-button", ".secondary-button"]) {
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

test("选中卡只有一圈金边：selectIcon 不做 programmatic focus", () => {
  const f = readFileSync(join(ROOT, "src/overlay.ts"), "utf8");
  const block = f.slice(f.indexOf("private selectIcon("), f.indexOf("private clearSelection("));
  assert.ok(block.includes('classList.add("is-selected")'), "选中仍加 is-selected 金边");
  assert.ok(!/\.focus\(/.test(block), "不再 programmatic focus（否则叠出 :focus-visible 第二圈）");
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  assert.match(css, /\.card\.is-selected\s*\{[^}]*outline:/, "is-selected 自身有金边");
});

test("启动窗重渲染不重播入场淡入（切语言不闪透明）", () => {
  const f = readFileSync(join(ROOT, "src/launcher.ts"), "utf8");
  assert.match(f, /dataset\.rendered/, "记录了是否已渲染");
  assert.match(f, /if \(!firstRender\) shell\.style\.animation = "none"/, "二次渲染关掉入场动画");
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  assert.match(css, /\.launcher-shell\s*\{[^}]*animation: launcher-in/, "入场动画仍只在首次渲染生效");
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
