/**
 * Excalidraw text baseline offset — mirrors `getVerticalOffset` in @excalidraw/excalidraw
 * so template text and lined-paper rules share the same vertical math.
 *
 * Helvetica/Cascadia default unitless lineHeights (1.15 / 1.2) match what Excalidraw
 * assigns when a skeleton omits `lineHeight` — use those for placement unless the
 * element explicitly carries another ratio.
 */

import { STATEMENT_LINE_HEIGHT_RATIO } from "./codeFontSize";
import { FONT_CODE, FONT_UI } from "../templates/skeleton";

type FontMetrics = {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  /** Excalidraw default unitless lineHeight for this family. */
  lineHeight: number;
};

/** Helvetica — Excalidraw FONT_FAMILY.Helvetica */
const HELVETICA: FontMetrics = {
  unitsPerEm: 2048,
  ascender: 1577,
  descender: -471,
  lineHeight: 1.15,
};

/** Cascadia — Excalidraw FONT_FAMILY.Cascadia */
const CASCADIA: FontMetrics = {
  unitsPerEm: 2048,
  ascender: 1900,
  descender: -480,
  lineHeight: 1.2,
};

function metricsFor(fontFamily: number | undefined): FontMetrics {
  if (fontFamily === FONT_CODE) return CASCADIA;
  return HELVETICA;
}

/** Default Excalidraw lineHeight for a font family. */
export function defaultLineHeight(fontFamily?: number): number {
  return metricsFor(fontFamily).lineHeight;
}

/**
 * Gap between glyph baseline and the ruled line — text sits just above the rule,
 * not glued onto it.
 */
export function linedRuleClearance(fontSize: number): number {
  /*
   * Clear the descenders, then leave air.
   *
   * 14% of the em put the rule inside the descender depth of every common
   * face — a `g` or a `p` came down through the line rather than sitting above
   * it, which reads as the text being glued to the rule rather than written on
   * it. A descender runs to roughly 21% of the font size, so the rule has to
   * start below that before any of the gap is breathing room.
   */
  return Math.max(4, fontSize * 0.26);
}

/** Scene-space distance from element `y` (top) to the first line's alphabetic baseline. */
export function textBaselineOffset(
  fontSize: number,
  lineHeightRatio: number,
  fontFamily?: number,
): number {
  const { unitsPerEm, ascender, descender } = metricsFor(fontFamily);
  const lineHeightPx = fontSize * lineHeightRatio;
  const fontSizeEm = fontSize / unitsPerEm;
  const ascPx = fontSizeEm * ascender;
  const descPx = fontSizeEm * descender;
  const lineGap = (lineHeightPx - ascPx + descPx) / 2;
  return ascPx + lineGap;
}

/** Baseline scene-y for a text element. */
export function textBaselineY(element: {
  y: number;
  fontSize?: number;
  lineHeight?: number;
  fontFamily?: number;
  customData?: { lcLineHeightBase?: number; lcFontBase?: number } | null;
}): number | null {
  const fontSize =
    typeof element.fontSize === "number" && element.fontSize > 0
      ? element.fontSize
      : element.customData?.lcFontBase;
  if (typeof fontSize !== "number" || !Number.isFinite(fontSize) || fontSize <= 0) {
    return null;
  }
  const fontFamily =
    element.fontFamily ??
    ((element.customData?.lcFontBase ?? fontSize) < 26 ? FONT_CODE : FONT_UI);
  const lineHeightRatio =
    typeof element.lineHeight === "number" && element.lineHeight > 0
      ? element.lineHeight
      : typeof element.customData?.lcLineHeightBase === "number"
        ? element.customData.lcLineHeightBase
        : defaultLineHeight(fontFamily);
  return element.y + textBaselineOffset(fontSize, lineHeightRatio, fontFamily);
}

/**
 * Place template text so row `row` (1-based) has its baseline just above the rule.
 */
export function topYForLinedRow(
  frameY: number,
  row: number,
  pitch: number,
  fontSize: number,
  fontFamily: number = FONT_UI,
  lineHeightRatio: number = defaultLineHeight(fontFamily),
): number {
  const ruleY = frameY + row * pitch;
  const baseline = ruleY - linedRuleClearance(fontSize);
  return baseline - textBaselineOffset(fontSize, lineHeightRatio, fontFamily);
}

/**
 * Lined-paper pitch used for scratchpad chrome (reading size is N/A there).
 *
 * Twice the statement's prose pitch. A problem board's rules have to land on
 * the baselines of typeset text, so they inherit the body font's spacing; a
 * scratch page has no text to agree with, only handwriting, and handwriting at
 * prose pitch on a page fitted to a tablet leaves about ten screen pixels a
 * line. This is the spacing of ruled paper, not of a paragraph.
 */
export const SCRATCH_LINE_PITCH = 72 * STATEMENT_LINE_HEIGHT_RATIO;
