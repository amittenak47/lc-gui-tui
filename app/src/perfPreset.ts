/**
 * Quality vs cost for the Android PDF reader.
 *
 * `ultra-low` keeps the same features (eager page *divs*, pdf.js text layer
 * for quotes/footnotes, ink, pan) and turns down GPU/CPU knobs so a flick
 * can be felt without 2× canvases, PNG encode, or background JBIG2 fill.
 *
 * This is not a 5-div virtual scroller. Gemini-style DOM ±2 would break
 * stack height (ink clip, pan clamp, `getClientRects`). Layout stays the
 * full book; only *paint* is a small ring.
 *
 * Flip to `"full"` to restore a wider GPU ring and PNG pagefile without
 * reverting 979a673. Rest scale is always 2× on the visible page (LOD).
 */
export type PerfPreset = "ultra-low" | "full";

export const PERF_PRESET: PerfPreset = "ultra-low";

const ULTRA = PERF_PRESET === "ultra-low";

/**
 * Rest raster for the page on screen. Original full preset (typical tablet DPR).
 * Not a pinch LOD — the board already scales the subtree.
 */
export const PDF_REST_SCALE = 2;
/** Neighbour / in-flight preview. 4× fewer pixels than rest. */
export const PDF_PREVIEW_SCALE = 1;
/** Alias of {@link PDF_REST_SCALE} for callers that mean hires. */
export const PDF_RENDER_SCALE = PDF_REST_SCALE;

/** Live GPU canvases: current ± this. 1 → three sheets; 3 → seven. */
export const PDF_HOT_RADIUS = ULTRA ? 1 : 3;

/** PNG pagefile cap. Unused while {@link PDF_PAGEFILE} is off. */
export const PDF_SESSION_CAP = ULTRA ? 8 : 80;

/** Compress paged-out canvases to PNG. Off = drop GPU, re-render on return. */
export const PDF_PAGEFILE = !ULTRA;

/** Decode pages between settles (TOC jumps). Off = no idle JBIG2. */
export const PDF_PATH_FILL = !ULTRA;

export const PDF_PAINT_INFLIGHT = ULTRA ? 1 : 2;

/** Filmstrip: extra pdf.js renders. Live canvas copies still run. */
export const PDF_FILM_DECODE_THUMBS = !ULTRA;

export const PDF_FILM_RADIUS = ULTRA ? 2 : 10;
export const PDF_FILM_CACHE = ULTRA ? 8 : 40;

/** Decoded ink bitmaps around the current page. */
export const INK_LRU_RADIUS = ULTRA ? 1 : 3;
