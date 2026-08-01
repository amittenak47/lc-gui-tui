/**
 * UI chrome themes — paired with board backgrounds so the browser overlay,
 * side panel, and canvas all feel like one surface.
 *
 * Light and dark swatches share a hue order: blue → green → pink → beige → purple.
 */

import { BOARD_THEMES, type BoardTheme } from "../templates/skeleton";

export type ThemeMode = "light" | "dark";

export interface AppTheme extends BoardTheme {
  panel: string;
  overlay: string;
  mode: ThemeMode;
}

interface ChromeEntry {
  panel: string;
  overlay: string;
  mode: ThemeMode;
}

const CHROME: Record<string, ChromeEntry> = {
  blue: { panel: "#dce7f4", overlay: "rgb(232 240 250 / 98%)", mode: "light" },
  green: { panel: "#dceee3", overlay: "rgb(232 244 236 / 98%)", mode: "light" },
  pink: { panel: "#f0e0e5", overlay: "rgb(248 235 238 / 98%)", mode: "light" },
  beige: { panel: "#ebe3d4", overlay: "rgb(245 239 228 / 98%)", mode: "light" },
  purple: { panel: "#e4dceb", overlay: "rgb(239 234 246 / 98%)", mode: "light" },
  ocean: { panel: "#1c2a35", overlay: "rgb(20 30 40 / 98%)", mode: "dark" },
  pine: { panel: "#1c2a24", overlay: "rgb(20 30 25 / 98%)", mode: "dark" },
  dusk: { panel: "#2e2028", overlay: "rgb(34 22 28 / 98%)", mode: "dark" },
  graphite: { panel: "#2a2723", overlay: "rgb(28 26 23 / 98%)", mode: "dark" },
  midnight: { panel: "#24202c", overlay: "rgb(23 20 31 / 98%)", mode: "dark" },
};

const LIGHT_TOKENS = {
  ink: "#1f2937",
  muted: "#5b6478",
  hint: "#6b7280",
  line: "#6b7280",
  accent: "#b45309",
  ok: "#166534",
  bad: "#b91c1c",
  surface: "rgb(255 255 255 / 94%)",
  selectEdge: "#3f4f63",
  selectFill: "rgb(63 79 99 / 11%)",
};

const DARK_TOKENS = {
  ink: "#e8eaed",
  muted: "#9aa3af",
  hint: "#7a8494",
  line: "#9aa3af",
  accent: "#f97316",
  ok: "#4ade80",
  bad: "#f87171",
  surface: "rgb(36 40 48 / 94%)",
  selectEdge: "#7dd3fc",
  selectFill: "rgb(125 211 252 / 14%)",
};

export const APP_THEMES: AppTheme[] = BOARD_THEMES.map((theme) => ({
  ...theme,
  ...CHROME[theme.id],
}));

const STORAGE_KEY = "lc-app-theme";

/** Map retired theme ids onto the current hue-ordered palette. */
const LEGACY_THEME_IDS: Record<string, string> = {
  // Classic neutrals → nearest hue
  paper: "beige",
  warm: "beige",
  cool: "blue",
  sage: "green",
  slate: "beige",
  // Parchment-era lights
  parchment: "beige",
  linen: "blue",
  sand: "beige",
  papyrus: "beige",
  wheat: "green",
};

export function loadThemeId(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return APP_THEMES[0].id;
    const resolved = LEGACY_THEME_IDS[stored] ?? stored;
    if (APP_THEMES.some((theme) => theme.id === resolved)) return resolved;
  } catch {
    /* private browsing */
  }
  return APP_THEMES[0].id;
}

export function saveThemeId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private browsing */
  }
}

export function applyAppTheme(id: string): AppTheme {
  const theme = APP_THEMES.find((candidate) => candidate.id === id) ?? APP_THEMES[0];
  const tokens = theme.mode === "dark" ? DARK_TOKENS : LIGHT_TOKENS;
  const root = document.documentElement;

  root.dataset.theme = theme.mode;
  root.style.setProperty("--bg", theme.background);
  root.style.setProperty("--panel", theme.panel);
  root.style.setProperty("--overlay-bg", theme.overlay);
  root.style.setProperty("--ink", tokens.ink);
  root.style.setProperty("--muted", tokens.muted);
  root.style.setProperty("--hint", tokens.hint);
  root.style.setProperty("--line", tokens.line);
  root.style.setProperty(
    "--chrome-edge",
    theme.mode === "dark" ? "#e5e7eb" : "#0c0a08",
  );
  root.style.setProperty("--accent", tokens.accent);
  root.style.setProperty("--ok", tokens.ok);
  root.style.setProperty("--bad", tokens.bad);
  root.style.setProperty("--surface", tokens.surface);
  root.style.setProperty("--select-edge", tokens.selectEdge);
  root.style.setProperty("--select-fill", tokens.selectFill);

  return theme;
}

export function isDarkTheme(id: string): boolean {
  return APP_THEMES.find((theme) => theme.id === id)?.mode === "dark";
}
