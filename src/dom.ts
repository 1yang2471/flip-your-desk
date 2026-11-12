export type IconName =
  | "close"
  | "minus"
  | "refresh"
  | "volume"
  | "mute"
  | "clock"
  | "move"
  | "alert"
  | "check"
  | "play"
  | "monitor"
  | "grid"
  | "cards";

const PATHS: Record<IconName, string> = {
  close: `<path d="M4 4l8 8M12 4l-8 8"/>`,
  minus: `<path d="M4 8h8"/>`,
  refresh: `<path d="M13.5 7A5.5 5.5 0 1 0 12 12.4"/><path d="M13.5 3.4V7H10"/>`,
  volume: `<path d="M7.5 3.6 4.6 6H2.6v4h2l2.9 2.4z"/><path d="M10.2 6.2a3 3 0 0 1 0 3.6"/>`,
  mute: `<path d="M7.5 3.6 4.6 6H2.6v4h2l2.9 2.4z"/><path d="M10.4 6.4l3.2 3.2M13.6 6.4l-3.2 3.2"/>`,
  clock: `<circle cx="8" cy="8" r="5.4"/><path d="M8 5v3.2l2.1 1.3"/>`,
  move: `<path d="M8 2.6v10.8M2.6 8h10.8"/><path d="M6 4.6 8 2.6l2 2M6 11.4l2 2 2-2M4.6 6 2.6 8l2 2M11.4 6l2 2-2 2"/>`,
  alert: `<path d="M8 2.8 14 13H2z"/><path d="M8 6.4v3.1M8 11.1v.7"/>`,
  check: `<path d="M3 8.4 6.4 12 13 4.6"/>`,
  play: `<path d="M5.6 3.4 12 8l-6.4 4.6z"/>`,
  monitor: `<rect x="2.4" y="3.4" width="11.2" height="7.2" rx="1"/><path d="M6 13.4h4M8 10.6v2.8"/>`,
  grid: `<rect x="2.4" y="2.4" width="4.6" height="4.6" rx="1"/><rect x="9" y="2.4" width="4.6" height="4.6" rx="1"/><rect x="2.4" y="9" width="4.6" height="4.6" rx="1"/><rect x="9" y="9" width="4.6" height="4.6" rx="1"/>`,
  cards: `<rect x="2.4" y="4.4" width="7.2" height="9" rx="1"/><path d="M5.6 2.4h6a1 1 0 0 1 1 1v8"/>`,
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function iconEl(name: IconName, size = 16): HTMLSpanElement {
  const span = h("span", "icon");
  span.setAttribute("aria-hidden", "true");
  span.innerHTML =
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" ` +
    `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
    `${PATHS[name]}</svg>`;
  return span;
}

export function clear(element: Element): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

export function button(
  className: string,
  label: string,
  icon?: IconName,
): HTMLButtonElement {
  const element = h("button", className);
  element.type = "button";
  element.setAttribute("aria-label", label);
  element.title = label;
  if (icon) element.appendChild(iconEl(icon));
  return element;
}
