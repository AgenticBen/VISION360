// Email styling that follows the person's on-screen display settings (text
// size and colors), so an emailed plan reads the way the page did.
//
// The colors are copied from site/demo/demo.css (tests/email-style.test.mjs
// checks they still match). Email clients ignore CSS variables and often drop
// <body> styles, so plan.mjs paints these values inline on table cells.

export const EMAIL_SIZES = ["100", "125", "150", "200", "300", "400"];
export const EMAIL_THEMES = {
  standard: { page: "#ffffff", surface: "#f4f6f8", ink: "#16191d", muted: "#4d555e", accent: "#051362", line: "#d2d8df", noteInk: "#5a3b00", noteBg: "#fff2d6", noteLine: "#8a5300" },
  blue: { page: "#0b2560", surface: "#102d6e", ink: "#ffffff", muted: "#dbe3f3", accent: "#ffd24a", line: "#34508f", noteInk: "#ffffff", noteBg: "#1a3c86", noteLine: "#ffd24a" },
  dark: { page: "#11151b", surface: "#1a2029", ink: "#f1f4f8", muted: "#c3cad3", accent: "#9cc1ff", line: "#343e4b", noteInk: "#f1f4f8", noteBg: "#1d2a44", noteLine: "#9cc1ff" },
  high: { page: "#000000", surface: "#000000", ink: "#ffffff", muted: "#ffffff", accent: "#ffd24a", line: "#ffffff", noteInk: "#ffffff", noteBg: "#000000", noteLine: "#ffd24a" },
};
export const THEME_NAMES = { standard: "standard colors", blue: "blue", dark: "dark", high: "high contrast" };

// The same rules as V360Display.normalize: unknown values fall back to the
// email default (standard size, standard colors).
export function normalizeDisplay(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const textSize = EMAIL_SIZES.includes(String(r.textSize)) ? String(r.textSize) : "100";
  const theme = Object.prototype.hasOwnProperty.call(EMAIL_THEMES, r.theme) ? r.theme : "standard";
  return { textSize, theme };
}

// Base body size in px: 18px at 100%, scaled by the chosen text size.
export function basePx(textSize) {
  return Math.round((18 * Number(textSize || 100)) / 100);
}

export function emailStyle(display) {
  const d = normalizeDisplay(display);
  const base = basePx(d.textSize);
  return {
    display: d,
    colors: EMAIL_THEMES[d.theme],
    px: { base, h1: Math.round(base * 1.45), h2: Math.round(base * 1.15), small: Math.round(base * 0.85) },
    describe: `${d.textSize}% text, ${THEME_NAMES[d.theme]}`,
  };
}
