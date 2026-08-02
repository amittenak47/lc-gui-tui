/**
 * Pen / ink swatches — soft stationery pastels, not saturated ROYGBIV primaries.
 * Light set stays readable on tinted boards; dark set stays soft on midnight tints.
 */

import { isDarkTheme } from "../theme/appThemes";

export const INK_COLORS_LIGHT = [
  "#3d3d3d", // graphite
  "#6d7eae", // periwinkle
  "#c07d91", // dusty rose
  "#8a7aaf", // wisteria
  "#6d9e8a", // sage
  "#c49163", // apricot
] as const;

export const INK_COLORS_DARK = [
  "#f0f0f0", // pearl
  "#a8bce8", // powder blue
  "#e8a4bf", // blush
  "#c4b0e8", // lilac
  "#98d4b0", // mint
  "#f0c896", // peach
] as const;

export function inkSwatches(themeId: string): readonly string[] {
  return isDarkTheme(themeId) ? INK_COLORS_DARK : INK_COLORS_LIGHT;
}

export function defaultInk(themeId: string): string {
  return isDarkTheme(themeId) ? INK_COLORS_DARK[0] : INK_COLORS_LIGHT[0];
}

/** Keep a stored pen colour only if this theme still offers it. */
export function resolveInkColor(themeId: string, preferred: string | null | undefined): string {
  const swatches = inkSwatches(themeId);
  if (preferred && swatches.includes(preferred)) return preferred;
  return defaultInk(themeId);
}
