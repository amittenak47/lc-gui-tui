/**
 * Palindrome preview ring around live C, rest 2 only on the sharp set.
 *
 * Rest-2 follows camera C. 0.25 preload may walk toward the flick-end guess
 * (Board publishes that list). Paint must not treat the guess as C.
 */

import { PDF_PREVIEW_RADIUS, PDF_PREVIEW_SCALE, PDF_REST_SCALE } from "../perfPreset";

export { PDF_PREVIEW_CACHE, PDF_PREVIEW_RADIUS, PDF_PREVIEW_SCALE, PDF_REST_SCALE } from "../perfPreset";

/** C−1, C, C+1 padding around the page under the camera. */
export const PDF_REST_NEIGHBOR = 1;

/** Outer 1× sheets: C−R … C … C+R, clamped to the book. */
export function pdfOuterPages(
  C: number,
  lastPage: number,
  R = PDF_PREVIEW_RADIUS,
): number[] {
  const last = Math.max(1, lastPage);
  const focus = Number.isFinite(C) ? Math.round(C) : 1;
  const lo = Math.max(1, focus - R);
  const hi = Math.min(last, focus + R);
  const out: number[] = [];
  for (let n = lo; n <= hi; n += 1) out.push(n);
  return out;
}

/** Sheets currently on screen — 2× rest scale. */
export function pdfInnerPages(visible: Iterable<number>): number[] {
  return [...new Set([...visible])].filter((n) => n >= 1).sort((a, b) => a - b);
}

/** One page slot, measured against the same coordinate space as the viewport. */
export interface PdfSlotSpan {
  page: number;
  top: number;
  bottom: number;
}

/**
 * Which pages a scroller is showing, and which one it is showing most of.
 *
 * The board answers this from its camera and its own layout frames. A pane
 * that scrolls with CSS has no camera, only boxes — but the answer feeding the
 * paint window has to be the same shape, or the pane paints on a different
 * rule from the reader and looks like it.
 *
 * `current` is the page covering the most of the viewport, not the topmost:
 * a sliver of the previous page hanging into view is not what you are reading.
 * Zero pages on screen answers `current: 0`, which callers read as "nothing to
 * publish yet" rather than page one.
 */
export function pdfVisibleFromSpans(
  slots: readonly PdfSlotSpan[],
  viewTop: number,
  viewBottom: number,
): { intersecting: number[]; current: number } {
  const covered = new Map<number, number>();
  for (const slot of slots) {
    if (!(slot.page >= 1)) continue;
    const overlap = Math.min(slot.bottom, viewBottom) - Math.max(slot.top, viewTop);
    if (!(overlap > 0)) continue;
    covered.set(slot.page, Math.max(covered.get(slot.page) ?? 0, overlap));
  }
  let current = 0;
  let best = 0;
  for (const [page, overlap] of covered) {
    if (overlap > best) {
      best = overlap;
      current = page;
    }
  }
  return {
    intersecting: [...covered.keys()].sort((a, b) => a - b),
    current,
  };
}

/**
 * Pages that should be rest 2: C±1 plus anyone whose frame is in the hole.
 * Live vs settled does not belong here.
 */
export function pdfRestPages(
  C: number,
  lastPage: number,
  intersecting: Iterable<number>,
  neighbor = PDF_REST_NEIGHBOR,
): number[] {
  const ids = new Set(pdfInnerPages(intersecting));
  const last = Math.max(1, lastPage);
  const focus = Number.isFinite(C) ? Math.round(C) : 1;
  for (let d = -neighbor; d <= neighbor; d += 1) {
    const n = focus + d;
    if (n >= 1 && n <= last) ids.add(n);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Decode / blit target: 2 inner, 1 outer, 0 outside the ring.
 */
export function pdfPageTargetScale(
  page: number,
  inner: Iterable<number>,
  outer: Iterable<number>,
  rest = PDF_REST_SCALE,
  preview = PDF_PREVIEW_SCALE,
): number {
  const onInner = inner instanceof Set ? inner : new Set(inner);
  if (onInner.has(page)) return rest;
  const onOuter = outer instanceof Set ? outer : new Set(outer);
  if (onOuter.has(page)) return preview;
  return 0;
}

/** C, then C±1, C±2, … C±R — fill the ring from the page under the camera. */
export function pdfExpandOrder(
  C: number,
  lastPage: number,
  R = PDF_PREVIEW_RADIUS,
): number[] {
  const last = Math.max(1, lastPage);
  const focus = Number.isFinite(C) ? Math.round(C) : 1;
  const out: number[] = [];
  const add = (n: number) => {
    if (n >= 1 && n <= last) out.push(n);
  };
  add(focus);
  for (let k = 1; k <= R; k += 1) {
    add(focus - k);
    add(focus + k);
  }
  return out;
}

/**
 * Layout has not reached C yet — do not decode page 1..last as a stand-in.
 */
export function pdfPaintShouldWaitForLanding(C: number, lastLaidOut: number): boolean {
  return Number.isFinite(C) && C >= 1 && lastLaidOut >= 1 && C > lastLaidOut;
}

/**
 * Who may call `page.render` on the shared pdf.js worker.
 *
 * Parked (`paused`) tears the observer down. Unfocused-but-visible
 * (`holdDecode`) keeps bitmaps and only yields the worker to the focused tab.
 */
export function pdfMayTakeWorker(paused: boolean, holdDecode: boolean): boolean {
  return !paused && !holdDecode;
}

/**
 * True when a landing hold can drop: this camera sample is actually on the
 * aimed page. A sample still on page 1 after jumpToPdfPage wrote page 47 must
 * not publish C or move the HTML slot.
 */
export function pdfLandingHoldClear(pending: number, cameraPage: number): boolean {
  return pending >= 1 && cameraPage === pending;
}

/**
 * Camera hole for the pump. If IO / camera Y still reports the top of the
 * stack while C is the session page, paint C — not page 1.
 */
export function pdfPaintHole(
  C: number,
  intersecting: Iterable<number>,
  near = PDF_PREVIEW_RADIUS,
): number[] {
  const focus = Number.isFinite(C) ? Math.round(C) : 1;
  const hole = [...new Set([...intersecting])].filter((n) => n >= 1);
  if (hole.includes(focus)) return hole;
  if (hole.length === 0) return [focus];
  if (hole.some((n) => Math.abs(n - focus) <= near)) return hole;
  return [focus];
}

/**
 * True only when pdf.js must run. `pixelScale` is LOD (0.25 / 2), not
 * `fit × LOD` — PdfSheetLru.lod() is the queue source. Fit changing (spread /
 * column) does not re-raster a rest-2 sheet; the same bitmap is drawn into the
 * new slots. Re-decoding JBIG2 on toggle froze the pad.
 */
export function pageNeedsDecode(
  fit: number,
  targetScale: number,
  pixelScale: number,
): boolean {
  if (!(targetScale > 0) || !(fit > 0)) return false;
  return !(pixelScale + 1e-6 >= targetScale);
}

/** 0.25 stubs from live C toward the flick-end guess. Never rest-2. */
export function pdfPreloadPages(
  live: number,
  pred: number,
  lastPage: number,
  cap = 6,
): number[] {
  if (!(pred >= 1) || !(live >= 1) || pred === live) return [];
  const last = Math.max(1, lastPage);
  const from = Math.round(live);
  const to = Math.round(pred);
  const step = to > from ? 1 : -1;
  const out: number[] = [];
  for (let n = from + step; n !== to + step; n += step) {
    if (n < 1 || n > last) break;
    out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * One pdf.js slot at a time. Per sheet: 0.25 then rest-2, walking C, ±1, …
 * Never rest-2 a cream slot — that is the 5s white wait. Do not fill the
 * whole 0.25 ring before C lossless: spread-off Kleinberg makes each stub a
 * full JBIG2 sheet, and lossless never arrived. Skip RAM that already meets
 * the target.
 */
export function pdfDecodeQueue(
  C: number,
  last: number,
  rest: ReadonlySet<number>,
  outer: ReadonlySet<number>,
  visible: Iterable<number>,
  scaleOf: (n: number) => number,
  fitOf: (n: number) => number,
  preload: Iterable<number> = [],
): { page: number; target: number }[] {
  const out: { page: number; target: number }[] = [];
  const seen = new Set<string>();
  const take = (n: number, target: number) => {
    if (!(n >= 1)) return;
    const key = `${n}:${target}`;
    if (seen.has(key)) return;
    const fit = fitOf(n);
    if (!(fit > 0)) return;
    if (!pageNeedsDecode(fit, target, scaleOf(n))) return;
    seen.add(key);
    out.push({ page: n, target });
  };
  const previewWanted = new Set<number>();
  for (const n of visible) if (n >= 1) previewWanted.add(n);
  for (const n of outer) previewWanted.add(n);
  for (const n of rest) previewWanted.add(n);
  for (const n of preload) if (n >= 1) previewWanted.add(n);
  for (const n of pdfExpandOrder(C, last)) {
    if (previewWanted.has(n)) take(n, PDF_PREVIEW_SCALE);
    if (rest.has(n)) take(n, PDF_REST_SCALE);
  }
  for (const n of previewWanted) take(n, PDF_PREVIEW_SCALE);
  return out;
}

/**
 * True when `head` should cancel `flight`.
 *
 * Cream in the hole beats everything. Rest-2 on C / the hole beats outer
 * 0.25 — otherwise spread-off cancels C lossless for every ring stub.
 * Same page at a higher target is an upgrade interrupt.
 */
export function pdfShouldPreempt(
  flight: { page: number; target: number },
  head: { page: number; target: number },
  C: number,
  hole: ReadonlySet<number>,
  rest: ReadonlySet<number>,
): boolean {
  if (flight.page === head.page && head.target > flight.target + 1e-9) return true;
  const rank = (job: { page: number; target: number }) => {
    const preview = job.target <= PDF_PREVIEW_SCALE + 1e-9;
    const lossless =
      rest.has(job.page) && job.target >= PDF_REST_SCALE - 1e-9;
    if (preview && hole.has(job.page)) return 0;
    if (lossless && (job.page === C || hole.has(job.page))) {
      return job.page === C ? 1 : 2;
    }
    if (preview) return 10 + Math.abs(job.page - C);
    if (lossless) return 100 + Math.abs(job.page - C);
    return 200 + Math.abs(job.page - C);
  };
  return rank(head) < rank(flight);
}

/** What the pump can tell about one page's text layer. */
export interface PdfPageTextState {
  /** The page has a slot in the stack. */
  laidOut: boolean;
  /** The slot carries a picture. */
  painted: boolean;
  /** The text layer already holds spans. */
  hasSpans: boolean;
  /** The pump has laid this page's text out and does not owe it another go. */
  filled: boolean;
}

/**
 * The first page on screen whose words are a picture and nothing else.
 *
 * A page painted while the camera was live never got a text layer — the paint
 * skips the fill mid-gesture, and the decode queue will not come back for the
 * page, because its pixels are already at the level of detail the window
 * wants. Nothing else would ever fill it. What the reader gets is a page they
 * can read and cannot quote: a hold-drag over it finds no text, so the
 * selection sheet has nothing to offer but Annotate.
 *
 * `filled` rather than `!hasSpans` is what stops the pump coming back: a page
 * with no strings on it lays out to an empty layer, and "no spans" would send
 * it round forever. `laidOut` is not a formality either — a page the caller
 * would decline is a page it would be handed again on the next turn.
 */
export function nextPdfPageMissingText(
  onScreen: Iterable<number>,
  stateOf: (page: number) => PdfPageTextState,
): number | null {
  for (const n of onScreen) {
    if (!(n >= 1)) continue;
    const state = stateOf(n);
    if (state.filled || !state.laidOut) continue;
    // Spans over a sheet with no picture would be a lie — the layer only ever
    // describes pixels that are actually there.
    if (!state.painted || state.hasSpans) continue;
    return n;
  }
  return null;
}
