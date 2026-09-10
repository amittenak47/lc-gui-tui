/** Tile edge in device pixels. */
export const TILE_PX = 384;
/**
 * Extra pixels past each tile edge, baked into the canvas only.
 *
 * A stroke that meets the square is rasterised with neighbour context so the
 * core-edge pixels are fully covered. The dest blit copies the core, not this
 * pad: overlapping dest copies of translucent ink stacked into a lattice the
 * colour of the stroke.
 *
 * 3px was enough for solid-ink AA. A drying wash that clips there still
 * showed a grid-aligned color cut, so the pad is on the order of a nib.
 */
export const TILE_OVERLAP_PX = 16;

/**
 * Zoom levels tiles are rasterised at, as steps of the exponent of two.
 *
 * Half-steps mean the worst-case resample between a tile and the screen is
 * √2 — visible as a touch of softness mid-gesture, gone as soon as the
 * background pass catches up. Whole steps would double that; quarter steps
 * would re-rasterise the page twice as often for a difference nobody sees.
 */
export const LEVEL_STEP = 0.5;

/** Device pixels per scene unit that a level rasterises at. */
export function levelScale(level: number): number {
  return 2 ** level;
}

/** Scene-space edge of one tile at a level. */
export function tileSceneSize(level: number, tilePx = TILE_PX): number {
  return tilePx / levelScale(level);
}

export function inkTileCanvasPx(tilePx = TILE_PX): number {
  return tilePx + 2 * TILE_OVERLAP_PX;
}
