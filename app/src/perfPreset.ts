/**
 * Quality vs cost for the Android PDF reader.
 *
 * One mixed profile: cheap 0.25 placeholders in a small C±2 ring, rest 2 on
 * the camera sharp set, one pdf.js raster at a time. Layout stays the full book.
 */

/** Rest raster for the page on screen. Not a pinch LOD — the board scales the subtree. */
export const PDF_REST_SCALE = 2;
/** Neighbour placeholder. Bitmap width ≈ 0.25 × column CSS width. */
export const PDF_PREVIEW_SCALE = 0.25;
/** Alias of {@link PDF_REST_SCALE} for callers that mean hires. */
export const PDF_RENDER_SCALE = PDF_REST_SCALE;

/**
 * Preview palindrome around live C. 2 → 5 sheets. Not the flick-end guess.
 * A ±12 ring kept 25 GPU canvases in play and hitching the compositor.
 */
export const PDF_PREVIEW_RADIUS = 2;
export const PDF_PREVIEW_CACHE = 2 * PDF_PREVIEW_RADIUS + 1;

/** PNG pagefile cap for LRU evictions (TOC jump-back). */
export const PDF_SESSION_CAP = 80;

/** Compress evicted LRU sheets to PNG. Idle encode only. */
export const PDF_PAGEFILE = true;

/** Decode skipped pages between settles into LRU / pagefile. Frozen while live. */
export const PDF_PATH_FILL = true;

export const PDF_PAINT_INFLIGHT = 1;

export const PDF_FILM_RADIUS = 3;
export const PDF_FILM_CACHE = 16;

/** Decoded ink stroke objects around the current page. Not PDF pixels. */
export const INK_LRU_RADIUS = 3;
