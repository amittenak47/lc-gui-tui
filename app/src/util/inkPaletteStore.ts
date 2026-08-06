/**
 * Per-slot overrides for the ink palette.
 *
 * The six swatches are positions, not colours: slot 0 is "the dark one you
 * write with", slot 4 is "the green". Overriding a slot changes what colour
 * sits there without changing what the slot is *for*, which is why this stores
 * a sparse map of index → colour rather than a replacement palette. A slot
 * nobody has touched keeps its authored default forever, and clearing one
 * brings that default straight back — there is no state in which the defaults
 * are gone.
 *
 * Kept per mode. Light and dark boards need genuinely different ink — the pale
 * set is unreadable on paper and the dark set vanishes on a black board — so a
 * writer picking their own colours is picking them for the boards they picked
 * them on, and switching theme must not carry a choice across that line.
 */

import { INK_COLORS_DARK, INK_COLORS_LIGHT } from "../canvas/inkColors";

export type InkPaletteMode = "light" | "dark";

/** Sparse: only the slots somebody has actually changed. */
export type InkPaletteOverrides = Record<number, string>;

const STORAGE_KEY = "lc.ink.palette.v1";

/** `#rgb` or `#rrggbb`, since a stored value can be anything a browser wrote. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function defaultSwatches(mode: InkPaletteMode): readonly string[] {
  return mode === "dark" ? INK_COLORS_DARK : INK_COLORS_LIGHT;
}

function readAll(): Record<InkPaletteMode, InkPaletteOverrides> {
  const empty = { light: {}, dark: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clean = (value: unknown, mode: InkPaletteMode): InkPaletteOverrides => {
      if (!value || typeof value !== "object") return {};
      const out: InkPaletteOverrides = {};
      const limit = defaultSwatches(mode).length;
      for (const [key, colour] of Object.entries(value as Record<string, unknown>)) {
        const index = Number(key);
        // A slot that no longer exists, or a value no colour input produced,
        // is dropped rather than allowed to poison the palette.
        if (!Number.isInteger(index) || index < 0 || index >= limit) continue;
        if (typeof colour !== "string" || !HEX.test(colour)) continue;
        out[index] = colour.toLowerCase();
      }
      return out;
    };
    return { light: clean(parsed.light, "light"), dark: clean(parsed.dark, "dark") };
  } catch {
    return empty;
  }
}

function writeAll(all: Record<InkPaletteMode, InkPaletteOverrides>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* private browsing — the palette just stays default for the session */
  }
}

export function loadInkOverrides(mode: InkPaletteMode): InkPaletteOverrides {
  return readAll()[mode];
}

/** The palette as it should be drawn: authored defaults with overrides on top. */
export function resolveSwatches(
  mode: InkPaletteMode,
  overrides: InkPaletteOverrides,
): string[] {
  return defaultSwatches(mode).map((colour, index) => overrides[index] ?? colour);
}

export function setInkOverride(
  mode: InkPaletteMode,
  index: number,
  colour: string,
): InkPaletteOverrides {
  const all = readAll();
  const limit = defaultSwatches(mode).length;
  if (!Number.isInteger(index) || index < 0 || index >= limit || !HEX.test(colour)) {
    return all[mode];
  }
  // Setting a slot back to its own default is a reset, not an override — it
  // keeps the stored map to the slots that genuinely differ, so re-theming or
  // a future change to the authored palette still reaches the untouched ones.
  const next = { ...all[mode] };
  if (defaultSwatches(mode)[index].toLowerCase() === colour.toLowerCase()) {
    delete next[index];
  } else {
    next[index] = colour.toLowerCase();
  }
  writeAll({ ...all, [mode]: next });
  return next;
}

export function clearInkOverride(mode: InkPaletteMode, index: number): InkPaletteOverrides {
  const all = readAll();
  const next = { ...all[mode] };
  delete next[index];
  writeAll({ ...all, [mode]: next });
  return next;
}

export function clearInkOverrides(mode: InkPaletteMode): InkPaletteOverrides {
  const all = readAll();
  writeAll({ ...all, [mode]: {} });
  return {};
}
