import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, asAppError } from "./api";
import { detectLang, errorText, t } from "./i18n";
import { initLauncher } from "./launcher";
import { OverlayGame, renderFatal } from "./overlay";
import "./styles.css";

function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return new URLSearchParams(window.location.search).get("view") ?? "launcher";
  }
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  const lang = detectLang();
  // 首屏就同步语言声明与窗口标题，避免静态 HTML 把英文用户标成中文。
  document.documentElement.lang = lang;
  document.title = t(lang, "app.windowTitle");
  const label = currentLabel();

  if (label.startsWith("overlay-")) {
    const monitor = Number(label.slice("overlay-".length));
    try {
      const view = await api.getOverlayView(monitor);
      const game = new OverlayGame(view, root);
      await game.init();
      await api.overlayReady(monitor);
    } catch (error) {
      const payload = asAppError(error);
      console.error("overlay failed", payload);
      renderFatal(root, errorText(detectLang(), payload.code), detectLang());
    }
    return;
  }

  await initLauncher(root);
  try {
    await getCurrentWindow().setTitle(t(lang, "app.windowTitle"));
  } catch {
    // 非 Tauri 环境（纯浏览器预览）没有窗口 API，页面标题已同步。
  }
}

void main();
