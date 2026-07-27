/**
 * UI chrome themes — paired with board backgrounds so the browser overlay,
 * side panel, and canvas all feel like one surface.
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
  parchment: { panel: "#ede8dc", overlay: "rgb(245 240 228 / 98%)", mode: "light" },
  linen: { panel: "#e4dcd0", overlay: "rgb(235 227 212 / 98%)", mode: "light" },
  sand: { panel: "#e0d4bc", overlay: "rgb(232 220 196 / 98%)", mode: "light" },
  papyrus: { panel: "#d4c8ac", overlay: "rgb(221 208 180 / 98%)", mode: "light" },
  wheat: { panel: "#dcc8a4", overlay: "rgb(229 212 176 / 98%)", mode: "light" },
  midnight: { panel: "#22252c", overlay: "rgb(26 29 35 / 98%)", mode: "dark" },
  graphite: { panel: "#2a2e38", overlay: "rgb(35 38 46 / 98%)", mode: "dark" },
  ocean: { panel: "#212a33", overlay: "rgb(26 34 41 / 98%)", mode: "dark" },
  pine: { panel: "#212824", overlay: "rgb(26 33 30 / 98%)", mode: "dark" },
  dusk: { panel: "#2a2428", overlay: "rgb(34 30 36 / 98%)", mode: "dark" },
};

const LIGHT_TOKENS = {
  ink: "#1f2937",
  muted: "#5b6478",
  hint: "#6b7280",
  line: "#d4d8de",
  accent: "#b45309",
  ok: "#166534",
  bad: "#b91c1c",
  surface: "rgb(255 255 255 / 94%)",
};

const DARK_TOKENS = {
  ink: "#e8eaed",
  muted: "#9aa3af",
  hint: "#7a8494",
  line: "#3d4450",
  accent: "#f97316",
  ok: "#4ade80",
  bad: "#f87171",
  surface: "rgb(36 40 48 / 94%)",
};

export const APP_THEMES: AppTheme[] = BOARD_THEMES.map((theme) => ({
  ...theme,
  ...CHROME[theme.id],
}));

const STORAGE_KEY = "lc-app-theme";

/** Map retired theme ids to their parchment-era replacements. */
const LEGACY_THEME_IDS: Record<string, string> = {
  paper: "parchment",
  warm: "sand",
  cool: "linen",
  sage: "wheat",
  slate: "papyrus",
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
  root.style.setProperty("--accent", tokens.accent);
  root.style.setProperty("--ok", tokens.ok);
  root.style.setProperty("--bad", tokens.bad);
  root.style.setProperty("--surface", tokens.surface);

  return theme;
}

export function isDarkTheme(id: string): boolean {
  return APP_THEMES.find((theme) => theme.id === id)?.mode === "dark";
}
