/**
 * UI chrome themes — paired with board backgrounds so the browser overlay,
 * side panel, and canvas all feel like one surface.
 *
 * Light and dark swatches share a hue order: sky → mint → rose → peach → lilac → coral.
 */

import { BOARD_THEMES, type BoardTheme } from "../templates/skeleton";

export type ThemeMode = "light" | "dark";

export interface AppTheme extends BoardTheme {
  panel: string;
  overlay: string;
  mode: ThemeMode;
}

/**
 * Mode defaults — what a theme gets before its own overrides in {@link CHROME}.
 *
 * Nothing here is expected to survive untouched on a real board; these are the
 * neutral fallbacks so a theme only has to name the tokens it actually cares
 * about, and so a new one is never unreadable while it is being tuned.
 */
const LIGHT_TOKENS = {
  ink: "#1f2937",
  muted: "#5b6478",
  hint: "#6b7280",
  line: "#c9ced6",
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
  line: "#333a45",
  accent: "#7dd3fc",
  ok: "#4ade80",
  bad: "#f87171",
  surface: "rgb(36 40 48 / 94%)",
  selectEdge: "#7dd3fc",
  selectFill: "rgb(125 211 252 / 14%)",
};

interface ChromeEntry {
  panel: string;
  overlay: string;
  mode: ThemeMode;
  /**
   * Palette overrides for this theme, layered over the mode defaults.
   *
   * Every light theme used to share one token set and every dark theme another,
   * so twelve "themes" were really two with the board tinted twelve ways — the
   * accent on a parchment board was the same burnt orange as on a rose one, and
   * neither was chosen for the paper under it. Each entry now carries the parts
   * that have to answer to its own background, and inherits the rest.
   */
  tokens?: Partial<typeof LIGHT_TOKENS>;
}

const CHROME: Record<string, ChromeEntry> = {
  // ── Papers ──────────────────────────────────────────────────────────────
  // Near-white with a cool cast; the accent is the one blue that reads as a
  // link on white without vibrating against it.
  blue: {
    panel: "#eef1f5",
    overlay: "rgb(251 252 253 / 98%)",
    mode: "light",
    tokens: { ink: "#1b1f24", muted: "#5a6472", hint: "#727d8c", line: "#c3cad3", accent: "#0b62d0", selectEdge: "#0b62d0", selectFill: "rgb(11 98 208 / 10%)" },
  },
  // Solarized Light's base3, with its yellow pulled darker until it holds up
  // as an accent rather than a highlighter.
  beige: {
    panel: "#f2ead4",
    overlay: "rgb(253 246 227 / 98%)",
    mode: "light",
    tokens: { ink: "#2f2a21", muted: "#6b6250", hint: "#7d7360", line: "#d5c9a8", accent: "#a35f11", selectEdge: "#a35f11", selectFill: "rgb(163 95 17 / 10%)" },
  },
  coral: {
    panel: "#f4e3d8",
    overlay: "rgb(251 238 230 / 98%)",
    mode: "light",
    tokens: { ink: "#2e231c", muted: "#6d5647", hint: "#7f6858", line: "#dcc4b4", accent: "#b8552b", selectEdge: "#b8552b", selectFill: "rgb(184 85 43 / 10%)" },
  },
  green: {
    panel: "#dfe9dd",
    overlay: "rgb(233 241 231 / 98%)",
    mode: "light",
    tokens: { ink: "#1c2b20", muted: "#4e6353", hint: "#607465", line: "#bdd0bf", accent: "#2f7d5a", selectEdge: "#2f7d5a", selectFill: "rgb(47 125 90 / 10%)" },
  },
  purple: {
    panel: "#e7e0f2",
    overlay: "rgb(241 236 249 / 98%)",
    mode: "light",
    tokens: { ink: "#241f2e", muted: "#5b5170", hint: "#6d6382", line: "#cdc2e0", accent: "#6d4bb5", selectEdge: "#6d4bb5", selectFill: "rgb(109 75 181 / 10%)" },
  },
  pink: {
    panel: "#f2e0e5",
    overlay: "rgb(251 238 241 / 98%)",
    mode: "light",
    tokens: { ink: "#2b1f24", muted: "#6b515b", hint: "#7d626c", line: "#dfc4cd", accent: "#b03a63", selectEdge: "#b03a63", selectFill: "rgb(176 58 99 / 10%)" },
  },

  // ── Blacks ──────────────────────────────────────────────────────────────
  // GitHub Dark. The default because it is the one most people's eyes are
  // already calibrated to.
  storm: {
    panel: "#161b22",
    overlay: "rgb(13 17 23 / 98%)",
    mode: "dark",
    tokens: { ink: "#e6edf3", muted: "#8b949e", hint: "#6e7681", line: "#30363d", accent: "#58a6ff", selectEdge: "#58a6ff", selectFill: "rgb(88 166 255 / 15%)" },
  },
  // Tokyo Night.
  midnight: {
    panel: "#24283b",
    overlay: "rgb(26 27 38 / 98%)",
    mode: "dark",
    tokens: { ink: "#c0caf5", muted: "#9aa5ce", hint: "#565f89", line: "#3b4261", accent: "#7aa2f7", selectEdge: "#7aa2f7", selectFill: "rgb(122 162 247 / 15%)" },
  },
  // Nord — Polar Night board, Snow Storm ink, Frost accent.
  ocean: {
    panel: "#3b4252",
    overlay: "rgb(46 52 64 / 98%)",
    mode: "dark",
    tokens: { ink: "#eceff4", muted: "#b8c1d1", hint: "#7b88a1", line: "#4c566a", accent: "#88c0d0", selectEdge: "#88c0d0", selectFill: "rgb(136 192 208 / 16%)" },
  },
  // As close to off as an OLED panel gets, for reading in the dark.
  graphite: {
    panel: "#141416",
    overlay: "rgb(10 10 11 / 98%)",
    mode: "dark",
    tokens: { ink: "#ededf0", muted: "#9a9aa4", hint: "#70707a", line: "#2a2a30", accent: "#7dd3fc", selectEdge: "#7dd3fc", selectFill: "rgb(125 211 252 / 15%)" },
  },
  pine: {
    panel: "#132523",
    overlay: "rgb(13 26 24 / 98%)",
    mode: "dark",
    tokens: { ink: "#e3efec", muted: "#9ab8b1", hint: "#6b8f86", line: "#27403b", accent: "#4fd6be", selectEdge: "#4fd6be", selectFill: "rgb(79 214 190 / 15%)" },
  },
  dusk: {
    panel: "#221929",
    overlay: "rgb(23 17 28 / 98%)",
    mode: "dark",
    tokens: { ink: "#ece6f2", muted: "#b3a5c2", hint: "#867596", line: "#382942", accent: "#c792ea", selectEdge: "#c792ea", selectFill: "rgb(199 146 234 / 15%)" },
  },
};

export const APP_THEMES: AppTheme[] = BOARD_THEMES.map((theme) => ({
  ...theme,
  ...CHROME[theme.id],
}));

/** This theme's palette: the mode's defaults with its own overrides on top. */
export function themeTokens(theme: AppTheme): typeof LIGHT_TOKENS {
  const base = theme.mode === "dark" ? DARK_TOKENS : LIGHT_TOKENS;
  return { ...base, ...(CHROME[theme.id]?.tokens ?? {}) };
}

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
  const tokens = themeTokens(theme);
  const root = document.documentElement;

  root.dataset.theme = theme.mode;
  root.style.setProperty("--bg", theme.background);
  root.style.setProperty("--panel", theme.panel);
  root.style.setProperty("--overlay-bg", theme.overlay);
  root.style.setProperty("--ink", tokens.ink);
  root.style.setProperty("--muted", tokens.muted);
  root.style.setProperty("--hint", tokens.hint);
  root.style.setProperty("--line", tokens.line);
  // The edge that separates chrome from board. Follows the theme's own line
  // colour rather than snapping to black-or-white, which on a parchment board
  // drew a hard rule nothing else in the palette agreed with.
  root.style.setProperty("--chrome-edge", tokens.line);
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
