/**
 * Pen / ink swatches — soft stationery pastels, not saturated ROYGBIV primaries.
 * Light set stays readable on tinted boards; dark set stays soft on midnight tints.
 */

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
