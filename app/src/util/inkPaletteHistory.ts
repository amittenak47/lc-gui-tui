/**
 * Per-annotation ink palette history.
 *
 * Each board keeps an ordered list of full palettes (usually four ColorHunt
 * colours, or the six authored defaults). Tap cycles forward (fetching when
 * past the end); hub tap cycles backward. Saved on {@link BoardBlob}.
 */

import { inkSwatches } from "../canvas/inkColors";

/** One palette = the swatches on the colour wheel. */
export type InkPalette = string[];

export interface InkPaletteHistory {
  items: InkPalette[];
  /** Index of the palette currently on the wheel. */
  index: number;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Cap so a long writing session cannot bloat the sidecar. */
export const INK_PALETTE_HISTORY_MAX = 40;

/** ColorHunt `code` dumps — offline / CORS fallback for random picks. */
export const COLORHUNT_FALLBACK_CODES = [
  "83e4b53ec8ac4e90a46e60a0",
  "7579e79ab3f5a3d8f4b9fffc",
  "10439f874cccc65bcff27bbd",
  "48383842855b90b77dd2d79f",
  "4f6f5273907286a789d2e3c8",
  "c82121dee1ecbecbff0d0cb5",
  "a5f1e97fe9defff6bfffebad",
  "fff7f1ffe4c9e78895bed1cf",
  "fdd2bfb97a958236cb290fba",
  "902424d9af5dcede48e9efba",
  "fafaf600fff000d1ff3d6cb9",
  "154d711c6ea433a1e0fff9af",
  "394a6d3c9d9b52de97c0ffb3",
  "d8c2925b5b5bb67171c19065",
  "feff86b0daffb9e9fcdaf5ff",
  "43352002595500917cfde8cd",
  "000000ff4191e90074fff078",
  "96b6c5adc4ceeee0c9f1f0e8",
  "7b99fa53cdd896eab7f1f3b8",
  "78b3cec9e6f0fbf8eff96e2a",
  "eeeeeeacc6aa71a0a577628c",
  "7d5a50b4846ce5b299fcdec0",
  "e5f9dba0d8b3a2a37883764f",
  "5bd1d7348498004d61ff502f",
  "d92243f69d39e0c375fff5e5",
  "cd5c08fff5e4c1d8c36a9c89",
  "76ba99876445ca955ceddfb3",
  "fcf9eabadfdbf8a978ffc5a1",
  "dddddd574e6d43405d4b586e",
  "fcefed6173f43b2e40f35e3e",
  "ffe0371dcd9f088c6f23033c",
  "eb4c4cff7070ffa6a6ffedc7",
  "2c29554c5fb1f9f194cdd582",
  "cefff1ace7efa6aceca56cc1",
  "e6e6e6c5a880532e1c0f0f0f",
  "ddddddd9adad84a9ac89c9b8",
  "fff3e2ffe5cafa9884e74646",
  "61d4b3fdd365fb8d62fd2eb3",
  "ecd6625d8233284e783e215d",
  "c7fffffbeeffebc6ff7e80ff",
] as const;

/** Split a 24-char ColorHunt code into `#rrggbb` swatches. */
export function paletteFromColorHuntCode(code: string): InkPalette | null {
  const raw = code.trim().toLowerCase().replace(/^#/, "");
  if (!/^[0-9a-f]{24}$/.test(raw)) return null;
  const out: InkPalette = [];
  for (let i = 0; i < 24; i += 6) {
    out.push(`#${raw.slice(i, i + 6)}`);
  }
  return out;
}

export function normalizePalette(colors: unknown): InkPalette | null {
  if (!Array.isArray(colors) || colors.length < 2) return null;
  const out: InkPalette = [];
  for (const colour of colors) {
    if (typeof colour !== "string" || !HEX.test(colour)) return null;
    out.push(colour.toLowerCase());
  }
  return out;
}

export function normalizeInkPaletteHistory(
  value: unknown,
  themeId: string,
): InkPaletteHistory {
  const fallback = seedInkPaletteHistory(themeId);
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const itemsRaw = record.items;
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) return fallback;
  const items: InkPalette[] = [];
  for (const entry of itemsRaw) {
    const palette = normalizePalette(entry);
    if (palette) items.push(palette);
  }
  if (items.length === 0) return fallback;
  const index =
    typeof record.index === "number" && Number.isInteger(record.index)
      ? Math.max(0, Math.min(items.length - 1, record.index))
      : 0;
  return { items, index };
}

export function seedInkPaletteHistory(themeId: string): InkPaletteHistory {
  return { items: [[...inkSwatches(themeId)]], index: 0 };
}

export function currentInkPalette(history: InkPaletteHistory): InkPalette {
  return history.items[history.index] ?? history.items[0] ?? [];
}

function paletteKey(palette: InkPalette): string {
  return palette.join(",").toLowerCase();
}

/** Trim from the front when over cap, keeping the active palette in range. */
export function trimInkPaletteHistory(history: InkPaletteHistory): InkPaletteHistory {
  if (history.items.length <= INK_PALETTE_HISTORY_MAX) return history;
  const drop = history.items.length - INK_PALETTE_HISTORY_MAX;
  return {
    items: history.items.slice(drop),
    index: Math.max(0, history.index - drop),
  };
}

export function appendInkPalette(
  history: InkPaletteHistory,
  palette: InkPalette,
): InkPaletteHistory {
  const key = paletteKey(palette);
  const existing = history.items.findIndex((item) => paletteKey(item) === key);
  if (existing >= 0) {
    return { items: history.items, index: existing };
  }
  return trimInkPaletteHistory({
    items: [...history.items, palette],
    index: history.items.length,
  });
}

export function cycleInkPalettePrev(history: InkPaletteHistory): InkPaletteHistory {
  if (history.items.length <= 1) return history;
  const index = (history.index - 1 + history.items.length) % history.items.length;
  return { ...history, index };
}

export function cycleInkPaletteNext(history: InkPaletteHistory): {
  history: InkPaletteHistory;
  needsFetch: boolean;
} {
  if (history.index < history.items.length - 1) {
    return { history: { ...history, index: history.index + 1 }, needsFetch: false };
  }
  return { history, needsFetch: true };
}

export function setInkPaletteSlot(
  history: InkPaletteHistory,
  slot: number,
  colour: string,
): InkPaletteHistory {
  if (!HEX.test(colour)) return history;
  const current = currentInkPalette(history);
  if (slot < 0 || slot >= current.length) return history;
  const nextPalette = current.map((c, i) => (i === slot ? colour.toLowerCase() : c));
  const items = history.items.map((item, i) => (i === history.index ? nextPalette : item));
  return { items, index: history.index };
}

/** Pick a fallback palette not already in history. */
export function pickFallbackPalette(history: InkPaletteHistory): InkPalette {
  const seen = new Set(history.items.map(paletteKey));
  const shuffled = [...COLORHUNT_FALLBACK_CODES].sort(() => Math.random() - 0.5);
  for (const code of shuffled) {
    const palette = paletteFromColorHuntCode(code);
    if (palette && !seen.has(paletteKey(palette))) return palette;
  }
  const code = COLORHUNT_FALLBACK_CODES[
    Math.floor(Math.random() * COLORHUNT_FALLBACK_CODES.length)
  ];
  return paletteFromColorHuntCode(code) ?? ["#3d3d3d", "#6d7eae", "#c07d91", "#8a7aaf"];
}
