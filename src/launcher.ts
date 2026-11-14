import { listen } from "@tauri-apps/api/event";

import { api, asAppError } from "./api";
import { storedMuted } from "./audio";
import { clear, h, iconEl } from "./dom";
import {
  APP_VERSION,
  detectLang,
  displaySummary,
  errorText,
  pluralKey,
  tDynamic,
  storeLang,
  t,
  type Lang,
} from "./i18n";
import type { CaptureProgress, EnvReport } from "./types";

interface LauncherState {
  lang: Lang;
  env: EnvReport | null;
  probing: boolean;
  starting: boolean;
  dealing: { done: number; total: number } | null;
  error: string | null;
  muted: boolean;
}

interface LauncherActions {
  recheck: () => void;
  start: (mode: "real" | "mock", timed?: boolean) => void;
  toggleLang: () => void;
  toggleMute: () => void;
  minimize: () => void;
  close: () => void;
}

export async function initLauncher(root: HTMLElement): Promise<void> {
  const state: LauncherState = {
    lang: detectLang(),
    env: null,
    probing: true,
    starting: false,
    dealing: null,
    error: null,
    muted: storedMuted(),
  };

  const actions: LauncherActions = {
    recheck: () => void probe(),
    start: (mode, timed) => void start(mode, timed),
    toggleLang: () => {
      const next: Lang = state.lang === "zh-CN" ? "en-US" : "zh-CN";
      state.lang = next;
      storeLang(next);
      render();
    },
    toggleMute: () => {
      state.muted = !state.muted;
      void api
        .setMuted(state.muted)
        .catch((error) => {
          console.error("mute failed", asAppError(error));
          state.muted = !state.muted;
        })
        .finally(render);
      render();
    },
    minimize: () => {
      void api.minimizeLauncher().catch((error) => {
        console.error("minimize failed", asAppError(error));
      });
    },
    close: () => {
      void api.quitApp();
    },
  };

  const render = () => renderLauncher(root, state, actions);

  const probe = async () => {
    state.probing = true;
    state.error = null;
    render();
    try {
      const env = await api.probeEnvironment();
      state.env = env;
      // 本地持久化优先：后端 InnerState 每次启动都是 false。
      state.muted = storedMuted();
      if (state.muted !== env.muted) void api.setMuted(state.muted);
    } catch (error) {
      const payload = asAppError(error);
      console.error("probe failed", payload);
      state.error = errorText(state.lang, payload.code);
    }
    state.probing = false;
    render();
  };

  const start = async (mode: "real" | "mock", timed = false) => {
    state.starting = true;
    state.error = null;
    render();
    try {
      await api.startRound(state.lang, mode, timed);
      state.dealing = null;
    } catch (error) {
      const payload = asAppError(error);
      console.error("start failed", payload);
      state.error = errorText(state.lang, payload.code);
      state.starting = false;
      state.dealing = null;
      render();
    }
  };

  render();
  await probe();
  void listen<{ code: string }>("start-failed", (event) => {
    state.starting = false;
    state.error = errorText(state.lang, event.payload.code);
    render();
  });
  await listen<CaptureProgress>("capture-progress", (event) => {
    state.dealing = event.payload;
    render();
  });
}

function renderLauncher(
  root: HTMLElement,
  state: LauncherState,
  actions: LauncherActions,
): void {
  const { lang, env } = state;
  clear(root);
  root.classList.add("launcher-root");

  const shell = h("div", "launcher-shell");

  // Header ---------------------------------------------------------------
  const head = h("header", "launcher-head");
  const brand = h("div", "brand");
  brand.setAttribute("data-tauri-drag-region", "");
  const mark = h("span", "brand-mark");
  mark.appendChild(h("span", "brand-mark-glyph", "?"));
  brand.appendChild(mark);
  const brandText = h("div", "brand-text");
  brandText.appendChild(h("strong", "brand-name", t(lang, "app.name")));
  brandText.appendChild(h("span", "brand-tagline", t(lang, "app.tagline")));
  brand.appendChild(brandText);
  head.appendChild(brand);

  const spacer = h("div", "head-spacer");
  spacer.setAttribute("data-tauri-drag-region", "");
  head.appendChild(spacer);

  const actionsRow = h("div", "head-actions");
  const langButton = h("button", "icon-button lang-button");
  langButton.type = "button";
  langButton.textContent = lang === "zh-CN" ? "EN" : "中文";
  langButton.title = t(lang, "launcher.language");
  langButton.setAttribute("aria-label", t(lang, "launcher.language"));
  langButton.addEventListener("click", actions.toggleLang);
  actionsRow.appendChild(langButton);

  const muteButton = h("button", "icon-button");
  muteButton.type = "button";
  muteButton.title = t(lang, state.muted ? "launcher.unmute" : "launcher.mute");
  muteButton.setAttribute(
    "aria-label",
    t(lang, state.muted ? "launcher.unmute" : "launcher.mute"),
  );
  muteButton.setAttribute("aria-pressed", String(state.muted));
  muteButton.appendChild(iconEl(state.muted ? "mute" : "volume"));
  muteButton.addEventListener("click", actions.toggleMute);
  actionsRow.appendChild(muteButton);

  const minimizeButton = h("button", "icon-button");
  minimizeButton.type = "button";
  minimizeButton.title = t(lang, "launcher.minimize");
  minimizeButton.setAttribute("aria-label", t(lang, "launcher.minimize"));
  minimizeButton.appendChild(iconEl("minus"));
  minimizeButton.addEventListener("click", actions.minimize);
  actionsRow.appendChild(minimizeButton);

  const closeButton = h("button", "icon-button");
  closeButton.type = "button";
  closeButton.title = t(lang, "launcher.close");
  closeButton.setAttribute("aria-label", t(lang, "launcher.close"));
  closeButton.appendChild(iconEl("close"));
  closeButton.addEventListener("click", actions.close);
  actionsRow.appendChild(closeButton);

  head.appendChild(actionsRow);
  shell.appendChild(head);

  const body = h("div", "launcher-body");

  // Environment ----------------------------------------------------------
  const panel = h("section", "status-panel");
  const panelHead = h("div", "panel-head");
  panelHead.appendChild(h("span", "panel-title", t(lang, "launcher.env")));
  const ready = !!env && env.issues.length === 0;
  const checking = state.probing && !env;
  const statusPill = h(
    "span",
    `status-pill ${checking ? "is-idle" : ready ? "is-ready" : "is-warn"}`,
  );
  statusPill.appendChild(iconEl(checking ? "refresh" : ready ? "check" : "alert", 13));
  statusPill.appendChild(
    h(
      "span",
      "",
      t(
        lang,
        checking ? "launcher.checking" : ready ? "launcher.ready" : "launcher.needsAttention",
      ),
    ),
  );
  panelHead.appendChild(statusPill);

  const recheck = h("button", "text-button");
  recheck.type = "button";
  recheck.appendChild(iconEl("refresh", 13));
  recheck.appendChild(
    h("span", "", t(lang, state.probing ? "launcher.rechecking" : "launcher.recheck")),
  );
  recheck.disabled = state.probing || state.starting;
  recheck.addEventListener("click", actions.recheck);
  panelHead.appendChild(recheck);
  panel.appendChild(panelHead);

  const rows = h("ul", "status-list");
  const addRow = (
    label: string,
    value: string,
    tone: "ok" | "warn" | "bad" | "idle",
  ) => {
    const item = h("li", "status-row");
    item.appendChild(h("span", "status-label", label));
    const valueWrap = h("span", "status-value");
    const dot = h("span", `status-dot is-${tone}`);
    dot.setAttribute("aria-hidden", "true");
    valueWrap.appendChild(dot);
    valueWrap.appendChild(h("span", "", value));
    item.appendChild(valueWrap);
    rows.appendChild(item);
  };

  if (!env || state.probing) {
    addRow(t(lang, "launcher.status.icons"), "…", "idle");
    addRow(t(lang, "launcher.status.displays"), "…", "idle");
    addRow(t(lang, "launcher.status.auto"), "…", "idle");
    addRow(t(lang, "launcher.status.visibility"), "…", "idle");
  } else {
    addRow(
      t(lang, "launcher.status.icons"),
      tDynamic(lang, pluralKey("launcher.value.icons", env.iconCount), { n: env.iconCount }),
      env.iconCount >= 2 ? "ok" : "bad",
    );
    addRow(
      t(lang, "launcher.status.displays"),
      displaySummary(lang, env.monitors),
      env.monitors.length > 0 ? "ok" : "bad",
    );
    addRow(
      t(lang, "launcher.status.auto"),
      t(lang, env.autoArrange ? "launcher.value.autoOn" : "launcher.value.autoOff"),
      env.autoArrange ? "warn" : "ok",
    );
    addRow(
      t(lang, "launcher.status.visibility"),
      t(lang, env.iconsVisible ? "launcher.value.visible" : "launcher.value.hidden"),
      env.iconsVisible ? "ok" : "bad",
    );
  }
  panel.appendChild(rows);

  if (env && env.issues.length > 0) {
    const issues = h("div", "issue-list");
    issues.appendChild(h("p", "issue-title", t(lang, "launcher.issueTitle")));
    for (const code of env.issues) {
      const issue = h("div", "issue");
      issue.appendChild(iconEl("alert", 14));
      const text = h("div", "issue-text");
      text.appendChild(h("p", "issue-name", tDynamic(lang, `issue.${code}.title`)));
      text.appendChild(h("p", "issue-hint", tDynamic(lang, `issue.${code}.hint`)));
      issue.appendChild(text);
      issues.appendChild(issue);
    }
    panel.appendChild(issues);
  }

  if (env && env.organizerDetected && env.issues.length === 0) {
    const notes = h("div", "issue-list");
    const item = h("div", "issue");
    item.appendChild(iconEl("alert", 13));
    const text = h("div", "issue-text");
    text.appendChild(h("p", "issue-name", t(lang, "launcher.organizerTitle")));
    text.appendChild(h("p", "issue-hint", t(lang, "launcher.organizerHint")));
    item.appendChild(text);
    notes.appendChild(item);
    panel.appendChild(notes);
  }

  if (env && env.probeError) {
    // 探测失败时 icon_count 不可信，直接展示真实错误码文案。
    const error = h("div", "inline-error");
    error.appendChild(iconEl("alert", 14));
    error.appendChild(h("span", "", errorText(lang, env.probeError)));
    panel.appendChild(error);
  }

  if (state.error) {
    const error = h("div", "inline-error");
    error.appendChild(iconEl("alert", 14));
    error.appendChild(h("span", "", state.error));
    panel.appendChild(error);
  }

  body.appendChild(panel);

  // How to play ----------------------------------------------------------
  const howto = h("section", "howto");
  howto.appendChild(h("p", "howto-title", t(lang, "launcher.howtoTitle")));
  const steps = h("ol", "howto-steps");
  const stepText = [
    t(lang, "launcher.howto.1"),
    t(lang, "launcher.howto.2"),
    t(lang, "launcher.howto.3"),
  ];
  stepText.forEach((text, index) => {
    const step = h("li", "howto-step");
    step.appendChild(h("span", "howto-index", `0${index + 1}`));
    step.appendChild(h("span", "howto-text", text));
    steps.appendChild(step);
  });
  howto.appendChild(steps);
  body.appendChild(howto);

  // Actions --------------------------------------------------------------
  const startButton = h("button", "primary-button");
  startButton.type = "button";
  const blocked = !env || env.issues.length > 0 || state.probing;
  startButton.disabled = blocked || state.starting;
  if (state.starting) {
    const spinner = h("span", "spinner");
    spinner.setAttribute("aria-hidden", "true");
    startButton.appendChild(spinner);
    startButton.appendChild(
      h(
        "span",
        "",
        t(
          lang,
          state.dealing ? "launcher.dealing" : "launcher.starting",
          state.dealing ?? undefined,
        ),
      ),
    );
  } else {
    startButton.appendChild(h("span", "", t(lang, "launcher.start")));
  }
  startButton.addEventListener("click", () => actions.start("real"));
  body.appendChild(startButton);

  const timedButton = h(
    "button",
    "timed-button",
    t(lang, "launcher.timed"),
  ) as HTMLButtonElement;
  timedButton.type = "button";
  timedButton.disabled = blocked || state.starting;
  timedButton.addEventListener("click", () => actions.start("real", true));
  body.appendChild(timedButton);

  if (blocked && env && env.issues.length > 0) {
    body.appendChild(h("p", "start-hint", t(lang, "launcher.startDisabled")));
  }

  if (import.meta.env.DEV) {
    const demo = h("button", "text-button demo-button");
    demo.type = "button";
    demo.appendChild(iconEl("play", 13));
    demo.appendChild(h("span", "", t(lang, "launcher.demo")));
    demo.disabled = state.starting;
    demo.addEventListener("click", () => actions.start("mock"));
    body.appendChild(demo);
  }

  shell.appendChild(body);

  // Footer ---------------------------------------------------------------
  const footer = h("footer", "launcher-footer");
  footer.appendChild(
    h("span", "", t(lang, "launcher.footer", { version: APP_VERSION })),
  );
  shell.appendChild(footer);

  root.appendChild(shell);
}
