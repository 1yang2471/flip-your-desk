import { enUS } from "./locales/en-US";
import { zhCN, type MessageKey } from "./locales/zh-CN";
import type { MonitorInfo } from "./types";

export type Lang = "zh-CN" | "en-US";

const dictionaries: Record<Lang, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

const STORAGE_KEY = "fyd.lang";
export const APP_VERSION = "0.4.0";

export function isLang(value: string | null | undefined): value is Lang {
  return value === "zh-CN" || value === "en-US";
}

export function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLang(stored)) return stored;
  } catch {
    // localStorage may be unavailable in restricted contexts.
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "en-US";
  return nav.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // The in-memory language still applies for this window.
  }
  document.documentElement.lang = lang;
}

export function t(
  lang: Lang,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  const dict = dictionaries[lang];
  let template = dict[key] ?? dictionaries["zh-CN"][key];
  if (template === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] 缺少文案: ${key}`);
    return key;
  }
  for (const [name, value] of Object.entries(vars)) {
    // 函数替换：图标名可能含 `$&`/`$'`，字符串替换会把它当成替换模式。
    template = template.replaceAll(`{${name}}`, () => String(value));
  }
  return template;
}

/** 运行时拼接的 key（如 `issue.${code}.title`）：必须显式走这个通道，
 *  并在 dev 下对缺失 key 告警，避免静默把 key 当文案显示给用户。 */
export function tDynamic(
  lang: Lang,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  return t(lang, key as MessageKey, vars);
}

export function pluralKey(base: string, n: number): string {
  return `${base}.${n === 1 ? "one" : "other"}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function errorText(lang: Lang, code: string): string {
  const key = `error.${code}`;
  if (key in dictionaries[lang]) return tDynamic(lang, key);
  if (key in dictionaries["zh-CN"]) return tDynamic(lang, key);
  return t(lang, "error.unknown");
}

export function primaryMonitor(monitors: MonitorInfo[]): MonitorInfo | undefined {
  return monitors.find((monitor) => monitor.primary) ?? monitors[0];
}

export function displaySummary(lang: Lang, monitors: MonitorInfo[]): string {
  const primary = primaryMonitor(monitors);
  const key =
    monitors.length === 1
      ? "launcher.value.displays.one"
      : "launcher.value.displays.other";
  return t(lang, key, {
    n: monitors.length,
    w: primary ? primary.width : 0,
    h: primary ? primary.height : 0,
  });
}