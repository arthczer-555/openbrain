// Instance theming: one accent color in openbrain.config.yaml, every shade derived from it.

function parse(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

const shade = (rgb: [number, number, number], f: number): string => hex([rgb[0] * f, rgb[1] * f, rgb[2] * f]);
const tint = (rgb: [number, number, number], t: number): string => hex([rgb[0] + (255 - rgb[0]) * t, rgb[1] + (255 - rgb[1]) * t, rgb[2] + (255 - rgb[2]) * t]);

export function applyTheme(accent: string): void {
  const rgb = parse(accent);
  if (!rgb) return;
  const root = document.documentElement.style;
  root.setProperty("--accent", hex(rgb));
  root.setProperty("--accent-ink", shade(rgb, 0.86));
  root.setProperty("--accent-deep", shade(rgb, 0.73));
  root.setProperty("--accent-darker", shade(rgb, 0.6));
  root.setProperty("--accent-soft", tint(rgb, 0.94));
  root.setProperty("--accent-softer", tint(rgb, 0.965));
  root.setProperty("--accent-border", tint(rgb, 0.82));
  root.setProperty("--accent-text", shade(rgb, 0.24));
  root.setProperty("--accent-text-2", shade(rgb, 0.38));
}
