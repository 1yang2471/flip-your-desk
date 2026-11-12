import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, asAppError } from "./api";
import { detectLang, errorText } from "./i18n";
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
      renderFatal(root, errorText(detectLang(), payload.code));
    }
    return;
  }

  await initLauncher(root);
}

void main();
