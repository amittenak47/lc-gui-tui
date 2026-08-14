/**
 * Theme a footnote hub + mark box from the board ink palette.
 *
 * Selected swatch is primary (borders / accents). Remaining swatches fill
 * surface / mid / deep roles by relative luminance. Labels use `--lc-fn-ink`,
 * picked for contrast against the *actual* card wash (palette light mixed into
 * the app `--panel`) — a pastel on a light theme stays dark type; the same
 * pastel on Storm/Graphite gets light type instead of vanishing.
 */

import type { CSSProperties } from "react";

const FALLBACK = ["#0d9488", "#5eead4", "#99f6e4", "#ccfbf1"] as const;
const INK_DARK = "#1c1917";
const INK_LIGHT = "#f5f0eb";
const SURFACE_FALLBACK = "#f8fafc";
/** Card = this much `--lc-fn-light` into the theme panel. */
const WASH_MIX = 0.42;
/** Nested chips sit a bit more in the palette than the card, never on raw `--panel`. */
const CHIP_MIX = 0.55;

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

function hexOf(rgb: [number, number, number]): string {
  return `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
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

export function contrastRatio(a: string, b: string): number {
  const L1 = relativeLuminance(a);
  const L2 = relativeLuminance(b);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

/** `amount` of `a` into `b` (same mix CSS `color-mix(in srgb, a amount, b)` uses). */
export function mixHex(a: string, b: string, amount: number): string {
  const A = parseHex(a);
  const B = parseHex(b);
  if (!A || !B) return a;
  const t = Math.min(1, Math.max(0, amount));
  return hexOf([
    Math.round(A[0] * t + B[0] * (1 - t)),
    Math.round(A[1] * t + B[1] * (1 - t)),
    Math.round(A[2] * t + B[2] * (1 - t)),
  ]);
}

function sameHex(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function readThemePanel(): string {
  if (typeof document === "undefined") return SURFACE_FALLBACK;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
  if (!raw) return SURFACE_FALLBACK;
  const hex = raw.startsWith("#") ? raw : `#${raw}`;
  return parseHex(hex) ? hex : SURFACE_FALLBACK;
}

/**
 * Darkest candidate, for callers that already know the wash is light.
 * Prefer a palette dark; otherwise {@link INK_DARK}.
 */
export function readableInk(...candidates: string[]): string {
  return readableInkOn(SURFACE_FALLBACK, candidates);
}

/** Best contrast against `background` from candidates, else dark/light fallback. */
export function readableInkOn(background: string, candidates: readonly string[]): string {
  const fallback = relativeLuminance(background) > 0.45 ? INK_DARK : INK_LIGHT;
  let best: string | null = null;
  let bestRatio = 0;
  for (const color of candidates) {
    if (!color?.trim()) continue;
    const ratio = contrastRatio(color.trim(), background);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = color.trim();
    }
  }
  if (best && bestRatio >= 3) return best;
  return fallback;
}

/**
 * CSS custom properties for `.lc-footnote-overview` / `.lc-doc-footnote-pack`.
 *
 * `--lc-fn-color` = selected primary (accents / borders — not body labels).
 * `--lc-fn-wash` / `--lc-fn-chip` = palette mixed into the theme panel.
 * `--lc-fn-ink` = readable label/body color on that wash.
 * `--lc-fn-p0`…`p3` = palette rotated so primary leads, then the rest.
 * `--lc-fn-light` / `--lc-fn-mid` / `--lc-fn-deep` = non-primary roles by luminance.
 *
 * `surface` is the theme `--panel`. Tests pass it; the app reads the live token.
 */
export function footnoteThemeVars(
  primary: string | undefined,
  palette: readonly string[],
  surface?: string,
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

  const paper = surface && parseHex(surface) ? surface.trim() : readThemePanel();
  const wash = mixHex(light, paper, WASH_MIX);
  const chip = mixHex(light, paper, CHIP_MIX);
  const ink = readableInkOn(wash, [deep, ...rest, pick]);
  const muted = mixHex(ink, wash, 0.62);

  /* Rotate: primary first, then remaining in wheel order — roles reassign on pick. */
  const rotated = [pick, ...rest];
  while (rotated.length < 4) rotated.push(rotated[rotated.length - 1] ?? pick);

  return {
    ["--lc-fn-color" as string]: pick,
    ["--lc-fn-ink" as string]: ink,
    ["--lc-fn-muted" as string]: muted,
    ["--lc-fn-wash" as string]: wash,
    ["--lc-fn-chip" as string]: chip,
    ["--lc-fn-p0" as string]: rotated[0],
    ["--lc-fn-p1" as string]: rotated[1],
    ["--lc-fn-p2" as string]: rotated[2],
    ["--lc-fn-p3" as string]: rotated[3],
    ["--lc-fn-deep" as string]: deep,
    ["--lc-fn-mid" as string]: mid,
    ["--lc-fn-light" as string]: light,
  };
}
