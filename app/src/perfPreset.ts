/**
 * Quality vs cost for the Android PDF reader.
 *
 * One mixed profile: cheap 0.25 placeholders in a small C±R ring, rest 2 on
 * the camera sharp set, one pdf.js raster at a time. Layout stays the full book.
 */

/** Rest raster for the page on screen. Not a pinch LOD — the board scales the subtree. */
export const PDF_REST_SCALE = 2;
/** Neighbour placeholder. Bitmap width ≈ 0.25 × column CSS width. */
export const PDF_PREVIEW_SCALE = 0.25;
/** Alias of {@link PDF_REST_SCALE} for callers that mean hires. */
export const PDF_RENDER_SCALE = PDF_REST_SCALE;

/**
 * Preview palindrome around live C. 3 → 7 sheets of 0.25. Rest-2 stays
 * {@link PDF_REST_CACHE}. A ±12 ring kept 25 GPU canvases and hitching.
 */
export const PDF_PREVIEW_RADIUS = 3;
/** Live 0.25 canvases = C±R. Not the rest-2 RAM cap. */
export const PDF_PREVIEW_CACHE = 2 * PDF_PREVIEW_RADIUS + 1;
/** Rest-2 sheets in RAM. Raising the 0.25 ring must not grow lossless. */
export const PDF_REST_CACHE = 5;

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
