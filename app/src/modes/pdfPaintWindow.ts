/**
 * Palindrome preview ring around live C, rest 2 only on the sharp set.
 *
 * Loads follow camera page, never the flick-end HUD guess.
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
 * True only when pdf.js must run. LRU already at target (or higher) is a blit.
 * Demote 2× → 1× is not a render.
 */
export function pageNeedsDecode(
  fit: number,
  targetScale: number,
  pixelScale: number,
): boolean {
  if (!(targetScale > 0) || !(fit > 0)) return false;
  return !(pixelScale + 1e-6 >= fit * targetScale);
}

/**
 * One pdf.js slot: kill white, then rest 2 on the sharp set, then ring 0.25.
 * Skip any page whose RAM already meets the target.
 */
export function pdfDecodeQueue(
  C: number,
  last: number,
  rest: ReadonlySet<number>,
  outer: ReadonlySet<number>,
  visible: Iterable<number>,
  scaleOf: (n: number) => number,
  fitOf: (n: number) => number,
): { page: number; target: number }[] {
  const out: { page: number; target: number }[] = [];
  const seen = new Set<number>();
  const take = (n: number, target: number) => {
    if (seen.has(n) || !(n >= 1)) return;
    const fit = fitOf(n);
    if (!(fit > 0)) return;
    if (!pageNeedsDecode(fit, target, scaleOf(n))) return;
    seen.add(n);
    out.push({ page: n, target });
  };
  for (const n of visible) take(n, PDF_PREVIEW_SCALE);
  for (const n of pdfExpandOrder(C, last)) {
    if (rest.has(n)) take(n, PDF_REST_SCALE);
  }
  for (const n of pdfExpandOrder(C, last)) {
    if (outer.has(n) && !rest.has(n)) take(n, PDF_PREVIEW_SCALE);
  }
  return out;
}

/**
 * True when `head` should cancel `flight`.
 *
 * Blank-in-hole 0.25 beats a neighbor decode. Rest 2 on C beats a 0.25 of
 * C+2. Same page at a higher target is an upgrade interrupt.
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
    if (hole.has(job.page) && job.target <= PDF_PREVIEW_SCALE + 1e-9) return 0;
    if (rest.has(job.page) && job.target >= PDF_REST_SCALE - 1e-9) {
      return 10 + Math.abs(job.page - C);
    }
    return 100 + Math.abs(job.page - C);
  };
  return rank(head) < rank(flight);
}
