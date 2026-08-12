/**
 * Theme a footnote hub + mark box from the board ink palette.
 *
 * Selected swatch is primary (borders / accents). Remaining swatches fill
 * surface / mid / deep roles by relative luminance. Labels use `--lc-fn-ink`,
 * which is forced dark enough to read on the light panel wash — never the
 * selected pastel itself (that made LINKS/NOTES vanish on mint cards).
 */

import type { CSSProperties } from "react";

const FALLBACK = ["#0d9488", "#5eead4", "#99f6e4", "#ccfbf1"] as const;
/** Floor for panel label ink — pastels in the deep role still need contrast. */
const INK_LUM_MAX = 0.38;
const INK_FALLBACK = "#1c1917";

function parseHex(color: string): [number, number, number] | null {
  const raw = color.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return [
      parseInt(raw[0]! + raw[0]!, 16),
      parseInt(raw[1]! + raw[1]!, 16),
      parseInt(raw[2]! + raw[2]!, 16),
    ];
  }
  if (/^[0-9a-f]{6}$/i.test(raw)) {
    return [
      parseInt(raw.slice(0, 2), 16),
      parseInt(raw.slice(2, 4), 16),
      parseInt(raw.slice(4, 6), 16),
    ];
  }
  return null;
}

/** sRGB relative luminance 0…1. */
export function relativeLuminance(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) return 0.5;
  const lin = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function sameHex(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Darkest candidate that still reads on a light panel wash. */
export function readableInk(...candidates: string[]): string {
  let best: string | null = null;
  let bestLum = Infinity;
  for (const color of candidates) {
    if (!color?.trim()) continue;
    const lum = relativeLuminance(color);
    if (lum < bestLum) {
      bestLum = lum;
      best = color.trim();
    }
  }
  if (best && bestLum <= INK_LUM_MAX) return best;
  return INK_FALLBACK;
}

/**
 * CSS custom properties for `.lc-footnote-overview` / `.lc-doc-footnote-pack`.
 *
 * `--lc-fn-color` = selected primary (accents / borders — not body labels).
 * `--lc-fn-ink` = readable label/body color on the light panel wash.
 * `--lc-fn-p0`…`p3` = palette rotated so primary leads, then the rest.
 * `--lc-fn-light` / `--lc-fn-mid` / `--lc-fn-deep` = non-primary roles by luminance.
 */
export function footnoteThemeVars(
  primary: string | undefined,
  palette: readonly string[],
): CSSProperties {
  const colors =
    palette.length >= 2
      ? palette.map((c) => c.trim()).filter(Boolean)
      : [...FALLBACK];
  while (colors.length < 4) colors.push(colors[colors.length - 1] ?? FALLBACK[0]);

  const pick =
    (primary && colors.find((c) => sameHex(c, primary))) ||
    primary?.trim() ||
    colors[0]!;

  const rest = colors.filter((c) => !sameHex(c, pick));
  const byLum = [...rest].sort(
    (a, b) => relativeLuminance(a) - relativeLuminance(b),
  );
  const deep = byLum[0] ?? pick;
  const light = byLum[byLum.length - 1] ?? pick;
  const mid = byLum[Math.floor((byLum.length - 1) / 2)] ?? pick;
  const ink = readableInk(deep, ...rest, pick);

  /* Rotate: primary first, then remaining in wheel order — roles reassign on pick. */
  const rotated = [pick, ...rest];
  while (rotated.length < 4) rotated.push(rotated[rotated.length - 1] ?? pick);

  return {
    ["--lc-fn-color" as string]: pick,
    ["--lc-fn-ink" as string]: ink,
    ["--lc-fn-p0" as string]: rotated[0],
    ["--lc-fn-p1" as string]: rotated[1],
    ["--lc-fn-p2" as string]: rotated[2],
    ["--lc-fn-p3" as string]: rotated[3],
    ["--lc-fn-deep" as string]: deep,
    ["--lc-fn-mid" as string]: mid,
    ["--lc-fn-light" as string]: light,
  };
}
