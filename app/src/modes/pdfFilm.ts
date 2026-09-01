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
/** Gap between filmstrip thumbs — matches `.lc-pdf-rail` layout. */
export const PDF_FILM_RAIL_GAP = 10;
export const PDF_FILM_RAIL_CELL = PDF_FILM_THUMB_CSS + PDF_FILM_RAIL_GAP;

/**
 * scrollLeft that puts `current` in the middle of the strip.
 * Used on open so remounting the rail does not jump back to page 1.
 */
export function pdfFilmRailScrollLeft(
  current: number,
  clientWidth: number,
  cell = PDF_FILM_RAIL_CELL,
  thumbW = PDF_FILM_THUMB_CSS,
): number {
  const focus = Math.max(1, current);
  const width = Math.max(0, clientWidth);
  return Math.max(0, (focus - 1) * cell - (width - thumbW) / 2);
}

/**
 * Which thumbs to mount: the strip's own viewport plus a window around the
 * page in view. Do not grow start to 1 just to include current. That mounted
 * every cell from the beginning and left the strip at scrollLeft 0 on reopen.
 */
export function pdfFilmRailWindow(
  current: number,
  count: number,
  scrollLeft: number,
  clientWidth: number,
  overscan = 8,
): { start: number; end: number } {
  const last = Math.max(1, count);
  const cell = PDF_FILM_RAIL_CELL;
  const first = Math.max(1, Math.floor(Math.max(0, scrollLeft) / cell) + 1);
  const visible = Math.max(1, Math.ceil(Math.max(cell, clientWidth) / cell));
  const focus = Math.max(1, Math.min(last, current || 1));
  const start = Math.max(1, Math.min(first - overscan, focus - overscan));
  const end = Math.min(last, Math.max(first + visible + overscan, focus + overscan));
  return { start, end };
}

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

/**
 * Where the reader is, per open document.
 *
 * This was a set of module globals, which was fine while one PDF could be
 * mounted. Two can: a split shows both, and the mount budget keeps a third
 * parked. Every mounted document wrote the same `filmCurrent`, the same
 * reading frames and the same visible-page sets, so they reset each other on
 * mount and the filmstrip, the preload pump and the ink remap all read
 * whichever document had published last — wrong-page navigation in one pane
 * because the other one scrolled.
 *
 * Scoped by *tab*, not by content hash. Thumbnails are hash-keyed and stay
 * that way: the same file rendered twice really is the same picture. A page
 * camera is not — two annotation sets over one PDF share a hash and share
 * nothing about where you are in it — so the slot that is already unique per
 * mounted workspace is the one to key on.
 */
type FilmNav = {
  current: number;
  currentListeners: Set<(page: number) => void>;
  /** Document-local PDF stack frames — camera Y maps to a page without IO. */
  readingFrames: PageFrame[];
  /** Lift-off landing guess — HUD / filmstrip ghost. Paint must not read this. */
  predicted: number;
  predictedListeners: Set<(page: number) => void>;
  /** 0.25 pages toward the flick-end. Separate from C — rest-2 must not read this. */
  preloadPages: number[];
  preloadListeners: Set<() => void>;
  paintWakeListeners: Set<() => void>;
  layoutBusy: boolean;
  layoutBusySince: number;
  layoutBusyClearTimer: number;
  layoutBusyMaxTimer: number;
  layoutBusyListeners: Set<(busy: boolean) => void>;
  /** Camera-hole pages (overlap) and rest-2 set. Not the flick-end guess. */
  intersectingPages: number[];
  restPages: number[];
  viewPageListeners: Set<() => void>;
  /** Strip cells the idle thumb pass should fill first. */
  thumbWanted: number[];
};

const navByScope = new Map<string, FilmNav>();

function nav(scope: string): FilmNav {
  let found = navByScope.get(scope);
  if (!found) {
    found = {
      current: 1,
      currentListeners: new Set(),
      readingFrames: [],
      predicted: 0,
      predictedListeners: new Set(),
      preloadPages: [],
      preloadListeners: new Set(),
      paintWakeListeners: new Set(),
      layoutBusy: false,
      layoutBusySince: 0,
      layoutBusyClearTimer: 0,
      layoutBusyMaxTimer: 0,
      layoutBusyListeners: new Set(),
      intersectingPages: [],
      restPages: [],
      viewPageListeners: new Set(),
      thumbWanted: [],
    };
    navByScope.set(scope, found);
  }
  return found;
}

/**
 * Forget a document's place. Call on unmount, not on park.
 *
 * A parked workspace keeps its page: coming back is showing it again, which is
 * the whole reason it stays mounted.
 */
export function clearPdfFilmScope(scope: string): void {
  const state = navByScope.get(scope);
  if (!state) return;
  if (state.layoutBusyClearTimer) clearTimeout(state.layoutBusyClearTimer);
  if (state.layoutBusyMaxTimer) clearTimeout(state.layoutBusyMaxTimer);
  navByScope.delete(scope);
}

/** Drop every scope. Tests only. */
export function resetPdfFilmScopes(): void {
  for (const scope of [...navByScope.keys()]) clearPdfFilmScope(scope);
}

export function setPdfReadingFrames(scope: string, frames: readonly PageFrame[]): void {
  nav(scope).readingFrames = frames.slice();
}

export function peekPdfReadingFrames(scope: string): readonly PageFrame[] {
  return nav(scope).readingFrames;
}

export function resetPdfReadingFrames(scope: string): void {
  nav(scope).readingFrames = [];
}

/** Spread on/off doubles or halves the slot list. Same count means layout has not published yet. */
export function pdfSpreadSlotCountChanged(fromCount: number, toCount: number): boolean {
  return fromCount >= 1 && toCount >= 1 && fromCount !== toCount;
}

/** Chrome filmstrip current page — does not go through Workspace setState. */
export function publishPdfFilmCurrent(scope: string, page: number): void {
  const state = nav(scope);
  if (!(page >= 1) || page === state.current) return;
  state.current = page;
  for (const listener of state.currentListeners) listener(page);
}

/**
 * Film current from camera Y + cached layout frames.
 *
 * IntersectionObserver on `.lc-pdf-page` misses sheets while the stack rides
 * `translate3d` — the strip jumped 3 → 5. Scene Y does not skip.
 */
export function publishPdfFilmFromCamera(
  scope: string,
  frames: readonly PageFrame[],
  scrollY: number,
  zoom: number,
  viewHeight: number,
): void {
  if (frames.length === 0) return;
  publishPdfFilmCurrent(scope, pageIdFromCamera(frames, scrollY, zoom, viewHeight));
}

export function subscribePdfFilmCurrent(
  scope: string,
  listener: (page: number) => void,
): () => void {
  const state = nav(scope);
  state.currentListeners.add(listener);
  listener(state.current);
  return () => {
    state.currentListeners.delete(listener);
  };
}

export function peekPdfFilmCurrent(scope: string): number {
  return nav(scope).current;
}

export function resetPdfFilmCurrent(scope: string): void {
  const state = nav(scope);
  if (state.current === 1) return;
  state.current = 1;
  for (const listener of state.currentListeners) listener(1);
}

export function publishPdfFilmPredicted(scope: string, page: number): void {
  const state = nav(scope);
  if (!(page >= 1) || page === state.predicted) return;
  state.predicted = page;
  for (const listener of state.predictedListeners) listener(page);
}

export function subscribePdfFilmPredicted(
  scope: string,
  listener: (page: number) => void,
): () => void {
  const state = nav(scope);
  state.predictedListeners.add(listener);
  listener(state.predicted);
  return () => {
    state.predictedListeners.delete(listener);
  };
}

export function resetPdfFilmPredicted(scope: string): void {
  const state = nav(scope);
  if (state.predicted === 0) return;
  state.predicted = 0;
  for (const listener of state.predictedListeners) listener(0);
}

export function publishPdfPreloadPages(scope: string, pages: readonly number[]): void {
  const state = nav(scope);
  const next = [...pages].filter((n) => n >= 1);
  if (samePageList(state.preloadPages, next)) return;
  state.preloadPages = next;
  for (const listener of state.preloadListeners) listener();
}

export function peekPdfPreloadPages(scope: string): readonly number[] {
  return nav(scope).preloadPages;
}

export function subscribePdfPreloadPages(scope: string, listener: () => void): () => void {
  const state = nav(scope);
  state.preloadListeners.add(listener);
  listener();
  return () => {
    state.preloadListeners.delete(listener);
  };
}

export function resetPdfPreloadPages(scope: string): void {
  const state = nav(scope);
  if (state.preloadPages.length === 0) return;
  state.preloadPages = [];
  for (const listener of state.preloadListeners) listener();
}

/** Wake the paint pump after spread remount when C and the hole did not move. */
export function wakePdfPaintPump(scope: string): void {
  for (const listener of nav(scope).paintWakeListeners) listener();
}

export function subscribePdfPaintWake(scope: string, listener: () => void): () => void {
  const state = nav(scope);
  state.paintWakeListeners.add(listener);
  return () => {
    state.paintWakeListeners.delete(listener);
  };
}

/**
 * Spread / column relayout: chrome spinner until the new stack is jumped.
 *
 * Clears are deferred at least {@link PDF_LAYOUT_BUSY_MIN_MS} so a same-tick
 * LRU blit cannot cancel the busy React update before the spinner paints.
 */
export const PDF_LAYOUT_BUSY_MIN_MS = 160;
const PDF_LAYOUT_BUSY_MAX_MS = 5000;

function emitLayoutBusy(state: FilmNav, busy: boolean): void {
  state.layoutBusy = busy;
  for (const listener of state.layoutBusyListeners) listener(state.layoutBusy);
}

export function publishPdfLayoutBusy(scope: string, busy: boolean): void {
  const state = nav(scope);
  if (state.layoutBusyClearTimer) {
    clearTimeout(state.layoutBusyClearTimer);
    state.layoutBusyClearTimer = 0;
  }
  if (busy) {
    if (state.layoutBusy) return;
    state.layoutBusySince =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    emitLayoutBusy(state, true);
    if (state.layoutBusyMaxTimer) clearTimeout(state.layoutBusyMaxTimer);
    state.layoutBusyMaxTimer = setTimeout(() => {
      state.layoutBusyMaxTimer = 0;
      if (state.layoutBusy) emitLayoutBusy(state, false);
    }, PDF_LAYOUT_BUSY_MAX_MS) as unknown as number;
    return;
  }
  if (!state.layoutBusy) return;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const wait = Math.max(0, PDF_LAYOUT_BUSY_MIN_MS - (now - state.layoutBusySince));
  const finish = () => {
    state.layoutBusyClearTimer = 0;
    if (state.layoutBusyMaxTimer) {
      clearTimeout(state.layoutBusyMaxTimer);
      state.layoutBusyMaxTimer = 0;
    }
    if (state.layoutBusy) emitLayoutBusy(state, false);
  };
  if (wait > 0) {
    state.layoutBusyClearTimer = setTimeout(finish, wait) as unknown as number;
  } else {
    finish();
  }
}

export function peekPdfLayoutBusy(scope: string): boolean {
  return nav(scope).layoutBusy;
}

export function subscribePdfLayoutBusy(
  scope: string,
  listener: (busy: boolean) => void,
): () => void {
  const state = nav(scope);
  state.layoutBusyListeners.add(listener);
  listener(state.layoutBusy);
  return () => {
    state.layoutBusyListeners.delete(listener);
  };
}

function samePageList(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((n, i) => n === b[i]);
}

export function publishPdfViewPages(
  scope: string,
  intersecting: readonly number[],
  rest: readonly number[],
): void {
  const state = nav(scope);
  const nextIntersect = [...intersecting];
  const nextRest = [...rest];
  if (
    samePageList(state.intersectingPages, nextIntersect) &&
    samePageList(state.restPages, nextRest)
  ) {
    return;
  }
  state.intersectingPages = nextIntersect;
  state.restPages = nextRest;
  for (const listener of state.viewPageListeners) listener();
}

export function subscribePdfViewPages(scope: string, listener: () => void): () => void {
  const state = nav(scope);
  state.viewPageListeners.add(listener);
  listener();
  return () => {
    state.viewPageListeners.delete(listener);
  };
}

export function peekPdfIntersectingPages(scope: string): readonly number[] {
  return nav(scope).intersectingPages;
}

export function peekPdfRestPages(scope: string): readonly number[] {
  return nav(scope).restPages;
}

export function resetPdfViewPages(scope: string): void {
  const state = nav(scope);
  if (state.intersectingPages.length === 0 && state.restPages.length === 0) return;
  state.intersectingPages = [];
  state.restPages = [];
  for (const listener of state.viewPageListeners) listener();
}

export function publishPdfFilmThumbWanted(scope: string, pages: readonly number[]): void {
  nav(scope).thumbWanted = [...pages].filter((n) => n >= 1);
}

export function peekPdfFilmThumbWanted(scope: string): readonly number[] {
  return nav(scope).thumbWanted;
}

export function resetPdfFilmThumbWanted(scope: string): void {
  nav(scope).thumbWanted = [];
}

/** Session JPEG thumbs keyed by document content hash, then page number. */
const thumbsByHash = new Map<string, Map<number, string>>();
/** Hashes opened this session — IDB prune must not drop these. */
const openedThumbHashes = new Set<string>();
const thumbListenersByHash = new Map<string, Set<() => void>>();
const thumbListenersAll = new Set<() => void>();

function notifyThumbListeners(hash: string): void {
  for (const listener of thumbListenersByHash.get(hash) ?? []) listener();
  for (const listener of thumbListenersAll) listener();
}

function capDocThumbs(hash: string, doc: Map<number, string>, around: number): Map<number, string> {
  if (doc.size <= PDF_FILM_CACHE) return doc;
  const next = trimThumbCache(doc, around, [around], PDF_FILM_CACHE);
  thumbsByHash.set(hash, next);
  return next;
}

export function rememberPdfThumb(hash: string | null | undefined, page: number, url: string): void {
  if (!hash || !(page >= 1) || !url) return;
  openedThumbHashes.add(hash);
  let doc = thumbsByHash.get(hash);
  if (!doc) {
    doc = new Map();
    thumbsByHash.set(hash, doc);
  }
  const prev = doc.get(page);
  if (prev === url) return;
  const first = !prev;
  doc.set(page, url);
  capDocThumbs(hash, doc, page);
  notifyThumbListeners(hash);
  if (first) void persistPdfThumb(hash, page, url);
}

/** Disk thumbs for this hash. Does not write IndexedDB again. */
export function hydratePdfThumbs(
  hash: string,
  thumbs: Map<number, string> | Iterable<readonly [number, string]>,
  around = 1,
): void {
  if (!hash) return;
  openedThumbHashes.add(hash);
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
  if (added) {
    capDocThumbs(hash, doc, around >= 1 ? around : 1);
    notifyThumbListeners(hash);
  }
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
  if (thumbsByHash.size === 0 && openedThumbHashes.size === 0) return;
  thumbsByHash.clear();
  openedThumbHashes.clear();
  for (const listeners of thumbListenersByHash.values()) {
    for (const listener of listeners) listener();
  }
  for (const listener of thumbListenersAll) listener();
}

export function subscribePdfThumbs(listener: () => void, hash?: string | null): () => void {
  if (hash) {
    let set = thumbListenersByHash.get(hash);
    if (!set) {
      set = new Set();
      thumbListenersByHash.set(hash, set);
    }
    set.add(listener);
    listener();
    return () => {
      set!.delete(listener);
      if (set!.size === 0) thumbListenersByHash.delete(hash);
    };
  }
  thumbListenersAll.add(listener);
  listener();
  return () => {
    thumbListenersAll.delete(listener);
  };
}

/** Hashes whose thumbs must stay on disk this session. */
export function openedPdfThumbHashes(): ReadonlySet<string> {
  return openedThumbHashes;
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

/**
 * First page in `prefer`, then 1…count, that has no session JPEG yet.
 *
 * `sweepAll` is what decides whether the fallback happens at all, and the
 * reading pump passes `false`.
 *
 * The sweep is the right behaviour for a caller that wants the strip warm and
 * is paying for it out of its own budget. It is the wrong one for the idle
 * decoder in the reader, which used it to walk a nine-hundred-page textbook a
 * page at a time, forever, from the moment the reader stopped scrolling: a
 * full `page.render` per page, a synchronous `toDataURL` per page, an
 * IndexedDB write and a listener broadcast per page, and a base64 JPEG per
 * page held in {@link thumbsByHash} — capped at {@link PDF_FILM_CACHE} — for a
 * strip that only ever shows that many of them. What the reader could feel
 * was the thread going away for a few hundred milliseconds at a time, on and
 * off, for as long as the book was open, and a `pointerdown` waiting for
 * whichever of those steps was on the stack when the finger landed.
 *
 * Bounded, the decoder fills what the strip and the reading ring actually
 * ask for and then stops. Pages outside that get their thumb for free when
 * the reader arrives at them, from a sheet already in the LRU.
 */
export function nextMissingPdfThumb(
  hash: string | null | undefined,
  count: number,
  prefer: Iterable<number> = [],
  skip: Iterable<number> = [],
  sweepAll = true,
): number | null {
  if (!hash || !(count >= 1)) return null;
  const have = thumbsByHash.get(hash);
  const skipped = skip instanceof Set ? skip : new Set(skip);
  const missing = (n: number) =>
    n >= 1 && n <= count && !have?.has(n) && !skipped.has(n);
  for (const n of prefer) {
    if (missing(n)) return n;
  }
  if (!sweepAll) return null;
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
  const url = grabLruPdfThumb(hash, page, Math.round(PDF_FILM_THUMB_CSS * dpr));
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
export function grabLruPdfThumb(hash: string, page: number, maxWidth: number): string | null {
  const sheet = peekActiveSheet(hash, page);
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
