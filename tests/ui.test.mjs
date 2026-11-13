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

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EDGE = ["C:", "Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"].join("\\");

const cssFile = readdirSync(join(ROOT, "dist/assets")).find((f) => /^index-.*\.css$/.test(f));
if (!cssFile) throw new Error("dist/assets 未找到 CSS，先跑 npm run build");
const cssText = readFileSync(join(ROOT, "dist/assets", cssFile), "utf8");

/** 一张卡背 + 一张透明卡面，复刻 overlay.ts 的 DOM 结构。 */
function scene() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${cssText}</style></head>
<body style="margin:0"><div class="overlay-root"><div class="board">
<button class="card card-back" id="back" style="width:76px;height:100px;transform:translate3d(0,0,0)">
  <span class="card-inner card-back-inner"><span class="card-back-mark">?</span><span class="card-back-dot"></span></span>
</button>
<button class="card card-face" id="face" style="width:76px;height:100px;transform:translate3d(200px,0,0)">
  <span class="card-inner card-face-inner is-photo">
    <img class="face-image" src="data:image/png;base64,iVBORw0KGgo=" alt="">
    <span class="face-name" style="top:58px;left:24px;width:76px">此电脑</span>
  </span>
</button>
</div></div></body></html>`;
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
