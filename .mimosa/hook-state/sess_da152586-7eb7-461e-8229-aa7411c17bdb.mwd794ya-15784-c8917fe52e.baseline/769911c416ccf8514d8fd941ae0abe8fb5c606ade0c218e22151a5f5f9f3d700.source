import { invoke } from "@tauri-apps/api/core";

import type {
  AppErrorPayload,
  EnvReport,
  OverlayView,
  PublicState,
  RoundResult,
  StartResponse,
} from "./types";

export function asAppError(error: unknown): AppErrorPayload {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return error as AppErrorPayload;
  }
  if (error instanceof Error) {
    return { code: "tauri", detail: error.message };
  }
  return { code: "unknown", detail: String(error) };
}

export const api = {
  probeEnvironment: () => invoke<EnvReport>("probe_environment"),
  startRound: (locale: string, mode: "real" | "mock") =>
    invoke<StartResponse>("start_round", { locale, mode }),
  overlayReady: (monitor: number) => invoke<void>("overlay_ready", { monitor }),
  getOverlayView: (monitor: number) =>
    invoke<OverlayView>("get_overlay_view", { monitor }),
  drawCard: (slot: number) => invoke<void>("draw_card", { slot }),
  moveCard: (fromSlot: number, toSlot: number) =>
    invoke<void>("move_card", { fromSlot, toSlot }),
  setDragHover: (slot: number | null) => invoke<void>("set_drag_hover", { slot }),
  finishRound: () => invoke<RoundResult>("finish_round"),
  replayRound: () => invoke<void>("replay_round"),
  setMuted: (muted: boolean) => invoke<void>("set_muted", { muted }),
  saveAndExit: () => invoke<void>("save_and_exit"),
  restoreAndExit: () => invoke<void>("restore_and_exit"),
  quitApp: () => invoke<void>("quit_app"),
  minimizeLauncher: () => invoke<void>("minimize_launcher"),
};

export type StateListener = (state: PublicState) => void;