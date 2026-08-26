/**
 * Bottom PDF filmstrip — which thumbs to keep, and a cheap copy from a page
 * already painted in the scene.
 *
 * The strip is chrome, not scene: it must not ask pdf.js for every page in a
 * textbook. Nearby pages copy their live canvas; the rest wait until they
 * scroll into the strip.
 *
 * JPEGs are remembered per document content hash (session + IndexedDB). A
 * missing page is decoded at ~48px only after the camera has been idle with
 * the filmstrip open — never from the reading paint pump.
 */

import { pageIdFromCamera, type PageFrame } from "../canvas/inkPageIndex";
import { peekActiveSheet } from "./pdfSheetCache";
import { persistPdfThumb } from "./pdfThumbStore";
import {
  PDF_FILM_CACHE,
  PDF_FILM_RADIUS,
} from "../perfPreset";

export type PdfThumbRenderer = (page: number) => Promise<string | null>;

export const PDF_FILM_PREF_KEY = "whiteboard.pdfFilm";
/** Replaces the old always-on number column — on until the reader hides it. */
export const PDF_FILM_DEFAULT = true;
export const PDF_FILM_THUMB_CSS = 48;
export { PDF_FILM_CACHE, PDF_FILM_RADIUS };
export const PDF_LETTER_ASPECT = 612 / 792;

/** Per-document two-up. Keyed by content hash so Kleinberg can stay on. */
export const PDF_SPREAD_PREF_PREFIX = "whiteboard.pdfSpread.";
export const PDF_SPREAD_DEFAULT = false;

export function loadPdfFilmPref(): boolean {
  try {
    const raw = localStorage.getItem(PDF_FILM_PREF_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* private mode */
  }
  return PDF_FILM_DEFAULT;
}

export function savePdfFilmPref(on: boolean): void {
  try {
    localStorage.setItem(PDF_FILM_PREF_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

export function loadPdfSpreadPref(docHash: string): boolean {
  if (!docHash) return PDF_SPREAD_DEFAULT;
  try {
    const raw = localStorage.getItem(PDF_SPREAD_PREF_PREFIX + docHash);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* private mode */
  }
  return PDF_SPREAD_DEFAULT;
}

export function savePdfSpreadPref(docHash: string, on: boolean): void {
  if (!docHash) return;
  try {
    localStorage.setItem(PDF_SPREAD_PREF_PREFIX + docHash, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

/** Vertical mouse wheel on a horizontal filmstrip → scrollLeft. */
export function filmStripWheelDelta(deltaX: number, deltaY: number): number {
  return Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
}

/**
 * Pages whose thumbnails should be filled.
 *
 * `current` plus a radius, unioned with whatever cells are on the strip's
 * own viewport. Caps at the document; empty current falls back to page 1.
 */
export function thumbWindow(
  current: number,
  count: number,
  extra: Iterable<number> = [],
  radius = PDF_FILM_RADIUS,
): number[] {
  const last = Math.max(1, count);
  const focus = Number.isFinite(current) ? current : 1;
  const wanted = new Set<number>();
  const add = (n: number) => {
    if (n >= 1 && n <= last) wanted.add(n);
  };
  for (let d = -radius; d <= radius; d += 1) add(focus + d);
  for (const n of extra) add(n);
  if (wanted.size === 0) add(1);
  return [...wanted].sort((a, b) => a - b);
}

/** Drop cached thumbs farthest from the page in view when the map is full. */
export function trimThumbCache(
  cache: Map<number, string>,
  current: number,
  keep: Iterable<number>,
  cap = PDF_FILM_CACHE,
): Map<number, string> {
  if (cache.size <= cap) return cache;
  const pinned = new Set(keep);
  const ranked = [...cache.keys()].sort((a, b) => {
    const pa = pinned.has(a) ? 0 : 1;
    const pb = pinned.has(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return Math.abs(a - current) - Math.abs(b - current);
  });
  const next = new Map<number, string>();
  for (const n of ranked.slice(0, cap)) {
    const url = cache.get(n);
    if (url) next.set(n, url);
  }
  return next;
}

let filmCurrent = 1;
const filmCurrentListeners = new Set<(page: number) => void>();

/** Document-local PDF stack frames — camera Y maps to a page without IO. */
let readingFrames: PageFrame[] = [];

export function setPdfReadingFrames(frames: readonly PageFrame[]): void {
  readingFrames = frames.slice();
}

export function peekPdfReadingFrames(): readonly PageFrame[] {
  return readingFrames;
}

export function resetPdfReadingFrames(): void {
  readingFrames = [];
}

/** Chrome filmstrip current page — does not go through Workspace setState. */
export function publishPdfFilmCurrent(page: number): void {
  if (!(page >= 1) || page === filmCurrent) return;
  filmCurrent = page;
  for (const listener of filmCurrentListeners) listener(page);
}

/**
 * Film current from camera Y + cached layout frames.
 *
 * IntersectionObserver on `.lc-pdf-page` misses sheets while the stack rides
 * `translate3d` — the strip jumped 3 → 5. Scene Y does not skip.
 */
export function publishPdfFilmFromCamera(
  frames: readonly PageFrame[],
  scrollY: number,
  zoom: number,
  viewHeight: number,
): void {
  if (frames.length === 0) return;
  publishPdfFilmCurrent(pageIdFromCamera(frames, scrollY, zoom, viewHeight));
}

export function subscribePdfFilmCurrent(
  listener: (page: number) => void,
): () => void {
  filmCurrentListeners.add(listener);
  listener(filmCurrent);
  return () => {
    filmCurrentListeners.delete(listener);
  };
}

export function peekPdfFilmCurrent(): number {
  return filmCurrent;
}

export function resetPdfFilmCurrent(): void {
  if (filmCurrent === 1) return;
  filmCurrent = 1;
  for (const listener of filmCurrentListeners) listener(1);
}

/** Lift-off landing guess — HUD / filmstrip ghost. Paint must not read this. */
let pdfFlickPredictPage = 0;
const filmPredictedListeners = new Set<(page: number) => void>();

export function publishPdfFilmPredicted(page: number): void {
  if (!(page >= 1) || page === pdfFlickPredictPage) return;
  pdfFlickPredictPage = page;
  for (const listener of filmPredictedListeners) listener(page);
}

export function subscribePdfFilmPredicted(
  listener: (page: number) => void,
): () => void {
  filmPredictedListeners.add(listener);
  listener(pdfFlickPredictPage);
  return () => {
    filmPredictedListeners.delete(listener);
  };
}

export function resetPdfFilmPredicted(): void {
  if (pdfFlickPredictPage === 0) return;
  pdfFlickPredictPage = 0;
  for (const listener of filmPredictedListeners) listener(0);
}

/** 0.25 pages toward the flick-end. Separate from C — rest-2 must not read this. */
let preloadPages: number[] = [];
const preloadListeners = new Set<() => void>();

export function publishPdfPreloadPages(pages: readonly number[]): void {
  const next = [...pages].filter((n) => n >= 1);
  if (samePageList(preloadPages, next)) return;
  preloadPages = next;
  for (const listener of preloadListeners) listener();
}

export function peekPdfPreloadPages(): readonly number[] {
  return preloadPages;
}

export function subscribePdfPreloadPages(listener: () => void): () => void {
  preloadListeners.add(listener);
  listener();
  return () => {
    preloadListeners.delete(listener);
  };
}

export function resetPdfPreloadPages(): void {
  if (preloadPages.length === 0) return;
  preloadPages = [];
  for (const listener of preloadListeners) listener();
}

/** Wake the paint pump after spread remount when C and the hole did not move. */
const paintWakeListeners = new Set<() => void>();

export function wakePdfPaintPump(): void {
  for (const listener of paintWakeListeners) listener();
}

export function subscribePdfPaintWake(listener: () => void): () => void {
  paintWakeListeners.add(listener);
  return () => {
    paintWakeListeners.delete(listener);
  };
}

/** Spread / column relayout: chrome spinner until page C is on screen again. */
let layoutBusy = false;
const layoutBusyListeners = new Set<(busy: boolean) => void>();

export function publishPdfLayoutBusy(busy: boolean): void {
  if (layoutBusy === busy) return;
  layoutBusy = busy;
  for (const listener of layoutBusyListeners) listener(layoutBusy);
}

export function peekPdfLayoutBusy(): boolean {
  return layoutBusy;
}

export function subscribePdfLayoutBusy(
  listener: (busy: boolean) => void,
): () => void {
  layoutBusyListeners.add(listener);
  listener(layoutBusy);
  return () => {
    layoutBusyListeners.delete(listener);
  };
}

function samePageList(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((n, i) => n === b[i]);
}

/** Camera-hole pages (overlap) and rest-2 set. Not the flick-end guess. */
let intersectingPages: number[] = [];
let restPages: number[] = [];
const viewPageListeners = new Set<() => void>();

export function publishPdfViewPages(
  intersecting: readonly number[],
  rest: readonly number[],
): void {
  const nextIntersect = [...intersecting];
  const nextRest = [...rest];
  if (samePageList(intersectingPages, nextIntersect) && samePageList(restPages, nextRest)) {
    return;
  }
  intersectingPages = nextIntersect;
  restPages = nextRest;
  for (const listener of viewPageListeners) listener();
}

export function subscribePdfViewPages(listener: () => void): () => void {
  viewPageListeners.add(listener);
  listener();
  return () => {
    viewPageListeners.delete(listener);
  };
}

export function peekPdfIntersectingPages(): readonly number[] {
  return intersectingPages;
}

export function peekPdfRestPages(): readonly number[] {
  return restPages;
}

export function resetPdfViewPages(): void {
  if (intersectingPages.length === 0 && restPages.length === 0) return;
  intersectingPages = [];
  restPages = [];
  for (const listener of viewPageListeners) listener();
}

/** Session JPEG thumbs keyed by document content hash, then page number. */
const thumbsByHash = new Map<string, Map<number, string>>();

export function rememberPdfThumb(hash: string | null | undefined, page: number, url: string): void {
  if (!hash || !(page >= 1) || !url) return;
  let doc = thumbsByHash.get(hash);
  if (!doc) {
    doc = new Map();
    thumbsByHash.set(hash, doc);
  }
  const prev = doc.get(page);
  if (prev === url) return;
  const first = !prev;
  doc.set(page, url);
  for (const listener of thumbListeners) listener();
  if (first) void persistPdfThumb(hash, page, url);
}

/** Disk thumbs for this hash. Does not write IndexedDB again. */
export function hydratePdfThumbs(
  hash: string,
  thumbs: Map<number, string> | Iterable<readonly [number, string]>,
): void {
  if (!hash) return;
  let doc = thumbsByHash.get(hash);
  if (!doc) {
    doc = new Map();
    thumbsByHash.set(hash, doc);
  }
  let added = false;
  for (const [page, url] of thumbs) {
    if (!(page >= 1) || !url || doc.has(page)) continue;
    doc.set(page, url);
    added = true;
  }
  if (added) for (const listener of thumbListeners) listener();
}

export function peekPdfThumb(hash: string | null | undefined, page: number): string | null {
  if (!hash || !(page >= 1)) return null;
  return thumbsByHash.get(hash)?.get(page) ?? null;
}

export function peekPdfThumbs(hash: string | null | undefined): Map<number, string> {
  if (!hash) return new Map();
  const doc = thumbsByHash.get(hash);
  return doc ? new Map(doc) : new Map();
}

export function resetPdfThumbs(): void {
  if (thumbsByHash.size === 0) return;
  thumbsByHash.clear();
  for (const listener of thumbListeners) listener();
}

const thumbListeners = new Set<() => void>();

export function subscribePdfThumbs(listener: () => void): () => void {
  thumbListeners.add(listener);
  listener();
  return () => {
    thumbListeners.delete(listener);
  };
}

/** Strip cells the idle thumb pass should fill first. */
let filmThumbWanted: number[] = [];

export function publishPdfFilmThumbWanted(pages: readonly number[]): void {
  filmThumbWanted = [...pages].filter((n) => n >= 1);
}

export function peekPdfFilmThumbWanted(): readonly number[] {
  return filmThumbWanted;
}

export function resetPdfFilmThumbWanted(): void {
  filmThumbWanted = [];
}

/**
 * pdf.js viewport scale so the bitmap is ~`cssWidth` CSS pixels wide.
 *
 * The stored JPEG is tiny. JBIG2 still fully decodes; we just do not paint
 * rest-2 into the LRU for this.
 */
export function pdfThumbViewportScale(
  naturalWidth: number,
  cssWidth = PDF_FILM_THUMB_CSS,
  dpr = 1,
): number {
  const targetW = cssWidth * Math.max(0.5, dpr);
  if (!(naturalWidth > 0) || !(targetW > 0)) return 0.12;
  return targetW / naturalWidth;
}

/** First page in `prefer`, then 1…count, that has no session JPEG yet. */
export function nextMissingPdfThumb(
  hash: string | null | undefined,
  count: number,
  prefer: Iterable<number> = [],
  skip: Iterable<number> = [],
): number | null {
  if (!hash || !(count >= 1)) return null;
  const have = thumbsByHash.get(hash);
  const skipped = skip instanceof Set ? skip : new Set(skip);
  const missing = (n: number) =>
    n >= 1 && n <= count && !have?.has(n) && !skipped.has(n);
  for (const n of prefer) {
    if (missing(n)) return n;
  }
  for (let n = 1; n <= count; n += 1) {
    if (missing(n)) return n;
  }
  return null;
}

/** 48 CSS px JPEG of an LRU sheet, once per page per document. Not a decode. */
export function capturePdfThumbIfNew(hash: string | null | undefined, page: number): void {
  if (!hash || !(page >= 1) || peekPdfThumb(hash, page)) return;
  const dpr =
    typeof window !== "undefined"
      ? Math.min(window.devicePixelRatio || 1, 2)
      : 1;
  const url = grabLruPdfThumb(page, Math.round(PDF_FILM_THUMB_CSS * dpr));
  if (url) rememberPdfThumb(hash, page, url);
}

export function grabLivePdfThumb(
  page: number,
  maxWidth: number,
  root: ParentNode | Document | null = typeof document !== "undefined" ? document : null,
): string | null {
  if (!root) return null;
  const slot = root.querySelector<HTMLElement>(
    `.lc-pdf-page[data-pdf-page="${page}"][data-painted]`,
  );
  const canvas = slot?.querySelector("canvas");
  if (!canvas || canvas.width < 8 || canvas.height < 8) return null;
  return snapshotThumb(canvas, canvas.width, canvas.height, maxWidth);
}

/** Filmstrip copy from the sheet LRU when the live canvas is empty. */
export function grabLruPdfThumb(page: number, maxWidth: number): string | null {
  const sheet = peekActiveSheet(page);
  if (!sheet || sheet.width < 8 || sheet.height < 8) return null;
  return snapshotThumb(sheet.bitmap, sheet.width, sheet.height, maxWidth);
}

function snapshotThumb(
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxWidth: number,
): string | null {
  const out = document.createElement("canvas");
  const w = Math.max(1, Math.round(maxWidth));
  const h = Math.max(1, Math.round(w * (srcH / srcW)));
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, w, h);
  try {
    return out.toDataURL("image/jpeg", 0.7);
  } catch {
    return null;
  }
}
