/**
 * A PDF as the page under the ink.
 *
 * Same contract as `AnnotateDocument`: no scrollbar of its own, no pointer of its
 * own in Annotate mode, laid out at full content height inside the board's page
 * frame so the whole stack rides the board camera as one thing. What is
 * different is that a PDF is not one flowing document but a run of fixed-size
 * pages, so this renders a vertical stack and reports the total height up.
 *
 * Each page is two layers. The canvas is the picture, and it is deliberately
 * inert — nothing is ever selected out of a bitmap. Over it sits pdf.js's text
 * layer: transparent, positioned spans holding the same words the picture
 * shows, which is what makes a hold-drag able to find a caret at all. That
 * layer is the only reason a PDF can be quoted rather than screenshotted.
 *
 * Rendered at a fixed scale in *scene* units, not at the camera's zoom. The
 * board scales this subtree itself, so re-rasterising on zoom would be doing
 * the same work twice and would reflow the text layer out from under any ink
 * already drawn on it. Rest uses {@link PDF_REST_SCALE}; neighbours keep
 * {@link PDF_PREVIEW_SCALE} until they fill the viewport.
 *
 * Only the pages near the reader are painted. Every page is *laid out* — the
 * stack has to be its true height or the frame the ink is clipped to ends
 * before the book does — but a laid-out page is a div with a size, while a
 * painted one is a bitmap. A palindrome preview ring (live C ±
 * {@link PDF_PREVIEW_RADIUS}) holds decoded sheets in an LRU; rest 2 is the
 * sharp set from camera Y, not IntersectionObserver. Scroll reuses the
 * overlap — it does not re-render. The flick-end HUD guess never feeds this
 * window.
 *
 * The text layer stays in the DOM while the bitmap pages out — footnotes and
 * quotes measure those spans, not the picture. Only an LRU drop from the
 * pagefile clears the spans (the bitmap is gone, so they would be a lie).
 */

import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";

import { isDocCameraLive, subscribeDocCameraLive } from "../canvas/docSelectionGesture";
import type { PageFrame } from "../canvas/inkPageIndex";
import {
  isCameraIdleForTeardown,
  msUntilCameraIdleTeardown,
  yieldToInput,
} from "../util/cameraBusy";
import {
  peekPdfFilmCurrent,
  peekPdfIntersectingPages,
  peekPdfRestPages,
  peekPdfPreloadPages,
  publishPdfFilmCurrent,
  resetPdfFilmCurrent,
  resetPdfFilmPredicted,
  resetPdfPreloadPages,
  resetPdfReadingFrames,
  resetPdfViewPages,
  setPdfReadingFrames,
  subscribePdfFilmCurrent,
  subscribePdfPaintWake,
  subscribePdfPreloadPages,
  subscribePdfViewPages,
  wakePdfPaintPump,
  type PdfThumbRenderer,
} from "./pdfFilm";
import {
  captureSheetPng,
  PDF_SESSION_CAP,
  PdfPageSession,
  restoreSheetPng,
  sessionPathPages,
} from "./pdfPageSession";
import {
  pageNeedsDecode,
  pdfDecodeQueue,
  pdfOuterPages,
  pdfPageTargetScale,
  pdfPaintHole,
  pdfPaintShouldWaitForLanding,
  pdfRestPages,
  pdfShouldPreempt,
} from "./pdfPaintWindow";
import {
  blitSheetToSlots,
  destSheetSize,
  PdfSheetLru,
  releaseSheet,
  setActiveSheetLru,
  snapshotSheet,
  type DroppedSheet,
  type SheetBitmap,
} from "./pdfSheetCache";
import {
  PDF_PAGEFILE,
  PDF_PAINT_INFLIGHT,
  PDF_PATH_FILL,
  PDF_PREVIEW_CACHE,
  PDF_PREVIEW_RADIUS,
  PDF_PREVIEW_SCALE,
  PDF_RENDER_SCALE,
  PDF_REST_CACHE,
  PDF_REST_SCALE,
} from "../perfPreset";
import { dropPdfDocument, lendPdfDocument } from "./pdfOpenDocs";
import { alignTextLayerToGlyphs } from "../util/pdfTextFit";

/**
 * Supersampling of the page bitmap relative to its scene size.
 *
 * Visible rest is {@link PDF_REST_SCALE} (2). Neighbours paint at
 * {@link PDF_PREVIEW_SCALE} so a flick is not rest-2 JBIG2 on every sheet.
 */
export { PDF_PREVIEW_SCALE, PDF_RENDER_SCALE, PDF_REST_SCALE };
export {
  pageNeedsDecode,
  pdfDecodeQueue,
  pdfExpandOrder,
  pdfInnerPages,
  pdfOuterPages,
  pdfPageTargetScale,
  pdfPaintHole,
  pdfPaintShouldWaitForLanding,
  pdfRestPages,
} from "./pdfPaintWindow";
export { PDF_PREVIEW_CACHE, PDF_PREVIEW_RADIUS } from "../perfPreset";

/** Gap between pages in scene units — a page break you can see, not a chasm. */
export const PAGE_GAP = 18;

/** `.lc-pdf-doc` padding-top — stack frames start here, not at Y 0. */
export const PDF_DOC_PAD_TOP = 18;

/**
 * A little slack around the viewport when deciding which pages are on screen.
 *
 * Deliberately small. The window is measured in *pages*, not in screens — see
 * {@link PDF_PREVIEW_RADIUS} — because at a width-fit zoom one page can be two
 * screens tall, and a margin expressed in viewports would then mean "half of
 * the page you are on".
 */
const PAGE_VISIBLE_MARGIN = "20% 0px";

/**
 * Live GPU slots: palindrome 0.25 around live C ({@link PDF_PREVIEW_RADIUS}).
 * Rest 2 only for the camera sharp set. LRU is full sheets, not L/R halves.
 */
export { PDF_SESSION_CAP } from "./pdfPageSession";

const PAGE_WINDOW_RADIUS = PDF_PREVIEW_RADIUS;

/**
 * Hard cap on GPU page slots. Matches the 1× ring so extras are the
 * far edge that just left C±R, not the whole book.
 */
const MAX_LIVE_CANVASES = PDF_PREVIEW_CACHE;

/**
 * How many page bitmaps the pump may decode at once.
 *
 * The window is filled in paint-order (on-screen first), but a scanned page's
 * JBIG2 decode can outlast a flick to the next sheet. Two in flight lets a
 * neighbour start while the focus page is still rendering, without stacking
 * a full ring of canvases at the same moment.
 */
const PAINT_INFLIGHT = PDF_PAINT_INFLIGHT;

/**
 * Page dimensions are fetched in batches rather than one at a time.
 *
 * `getPage` is a round trip to the worker; 1500 of them in series is a wait the
 * reader sits through before the book appears at all. Parsing a page's
 * dictionary is cheap — it is `render` that is not — so they can safely go out
 * together, bounded only so the worker's queue stays responsive to the first
 * pages, which are the ones about to be painted.
 */
const LAYOUT_BATCH = 32;

export interface PdfDocumentProps {
  /** The file's bytes. pdf.js takes ownership of the buffer it is given. */
  bytes: ArrayBuffer;
  /**
   * Content hash of these bytes — the indexer borrows this open document
   * instead of parsing a second 44 MB copy into the same worker.
   */
  docHash?: string | null;
  /**
   * Scene width of the page frame this stack sits in.
   *
   * Pages are laid out *to* this rather than at their natural size and scaled
   * afterwards. A CSS transform over the stack would be the one-line version
   * and would be wrong twice: the text layer positions its spans in absolute
   * pixels, so it would come apart from the picture, and the selection layer
   * measures the board camera's zoom from the document's own box — a second
   * scale inside it would be read as camera zoom and put every highlight in
   * the wrong place.
   */
  frameWidth: number;
  /** Reported whenever the rendered stack height changes, in scene units. */
  onMeasure?: (height: number) => void;
  /** Page count and the page filling most of the viewport — for the filmstrip. */
  onNav?: (nav: PdfNav | null) => void;
  /**
   * Cheap page bitmaps for the filmstrip. Same open document as the scene —
   * a second `getDocument` would double the worker and fight the paint pump.
   */
  onThumbRenderer?: (render: PdfThumbRenderer | null) => void;
  /**
   * Two-up / spread: each PDF sheet is two stacked reading slots (left, then
   * right), each as wide as the column. Off = width-fit the whole sheet.
   */
  spread?: boolean;
  /** Scroll mode: the text layer answers the pointer so quotes can be picked. */
  selectable?: boolean;
  onError?: (message: string) => void;
  /**
   * Last session page (1-based). Paint starts here instead of page 1 while
   * the camera restore is still waiting on the layout gate.
   */
  initialPage?: number;
}

/** Viewport index plus per-page width/height for filmstrip placeholders. */
export interface PdfNav {
  count: number;
  current: number;
  aspects: number[];
}

export type { PdfThumbRenderer } from "./pdfFilm";

/**
 * Loaded lazily: pdf.js is ~1 MB and no problem board ever needs it.
 *
 * The `legacy` build, not the default one. pdf.js 6 reaches for JavaScript that
 * is newer than the runtime this ships on — `Map.prototype.getOrInsertComputed`
 * among others — and the modern build assumes it is there, so a page render
 * dies with a `not a function` on the Android WebView and on any browser more
 * than a few months behind. The legacy build carries the polyfills. It is the
 * same renderer and the same text layer; what it costs is a slightly larger
 * chunk that is already lazy.
 */
/** One worker for the app lifetime — a new `workerPort` per open hangs getDocument. */
let pdfJsLoader: Promise<typeof import("pdfjs-dist")> | null = null;

export async function loadPdfJs() {
  if (pdfJsLoader) return pdfJsLoader;
  pdfJsLoader = (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<typeof import("pdfjs-dist")>,
      // `?worker` rather than `new URL(..., import.meta.url)`: Vite only rewrites
      // the URL form for relative paths, and a bare specifier there silently
      // ships no worker chunk at all. Without a worker pdf.js parses on the main
      // thread, which locks the pen for seconds on a textbook.
      import("pdfjs-dist/legacy/build/pdf.worker.mjs?worker"),
    ]);
    pdfjs.GlobalWorkerOptions.workerPort = new worker.default();
    return pdfjs;
  })();
  return pdfJsLoader;
}

type PdfJs = Awaited<ReturnType<typeof loadPdfJs>>;
type PdfWorker = InstanceType<PdfJs["PDFWorker"]>;

let sharedWorker: PdfWorker | null = null;

export function pdfWorker(pdfjs: PdfJs): PdfWorker {
  sharedWorker ??= pdfjs.PDFWorker.create({
    // `loadPdfJs` has already set this; `?? undefined` only satisfies the type,
    // and a missing port would mean pdf.js spawns its own worker rather than
    // failing — which is still a working PDF, just not the shared one.
    port: pdfjs.GlobalWorkerOptions.workerPort ?? undefined,
  }) as PdfWorker;
  return sharedWorker;
}

/**
 * URLs pdf.js fetches at render time (fonts, cmaps, JBIG2/JPEG2000 decoders).
 *
 * Copied into `dist/` by `pdfjsAssets` in vite.config. `wasmUrl` is required
 * for scanned textbooks: a missing decoder still lays the page boxes out, so
 * the board shows a stack of white sheets and blank filmstrip thumbs.
 */
export function pdfJsDataUrls(base = document.baseURI): {
  standardFontDataUrl: string;
  cMapUrl: string;
  wasmUrl: string;
} {
  return {
    standardFontDataUrl: new URL("standard_fonts/", base).href,
    cMapUrl: new URL("cmaps/", base).href,
    wasmUrl: new URL("wasm/", base).href,
  };
}

interface RenderedPage {
  pageNumber: number;
  /** Natural-size → slot-width factor (doubled when spread). */
  fit: number;
  /** Slot width in scene units (the column). */
  width: number;
  /** Full sheet width at `fit` — twice the slot when spread. */
  sheetWidth: number;
  height: number;
}

/** MediaBox at scale 1 — enough to relayout spread without another getPage storm. */
export interface PdfPageNatural {
  pageNumber: number;
  width: number;
  height: number;
}

/** Width-fit the sheet, or fit one half of a two-up scan to the column. */
export function pdfPageFit(
  naturalWidth: number,
  frameWidth: number,
  spread = false,
): number {
  if (!(naturalWidth > 0) || !(frameWidth > 0)) return 1;
  return spread ? (2 * frameWidth) / naturalWidth : frameWidth / naturalWidth;
}

/**
 * Slot sizes from cached MediaBoxes. Spread / column resize must not
 * `getDocument` again — Kleinberg is hundreds of dictionary round-trips.
 */
export function layoutPdfPages(
  naturals: readonly PdfPageNatural[],
  frameWidth: number,
  spread = false,
): RenderedPage[] {
  return naturals.map((natural) => {
    const fit = pdfPageFit(natural.width, frameWidth, spread);
    const fullW = Math.round(natural.width * fit);
    const fullH = Math.round(natural.height * fit);
    return {
      pageNumber: natural.pageNumber,
      fit,
      sheetWidth: fullW,
      width: spread ? Math.max(1, Math.round(fullW / 2)) : fullW,
      height: fullH,
    };
  });
}

/**
 * Scene-local frames for every reading slot (two per sheet when spread).
 *
 * Camera Y uses this instead of IntersectionObserver. Same `pageId` on two
 * stacked halves is correct for the filmstrip (PDF page count, not L/R cells).
 */
export function pdfStackFrames(
  pages: readonly { pageNumber: number; height: number }[],
  spread = false,
  gap = PAGE_GAP,
  originY = 0,
): PageFrame[] {
  const frames: PageFrame[] = [];
  let y = originY;
  for (const page of pages) {
    const slots = spread ? 2 : 1;
    for (let i = 0; i < slots; i += 1) {
      frames.push({
        pageId: page.pageNumber,
        minY: y,
        maxY: y + page.height,
      });
      y += page.height + gap;
    }
  }
  return frames;
}

function queryPageSlots(host: HTMLElement, n: number): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(`[data-pdf-page="${n}"]`)];
}

function zeroPageSlots(host: HTMLElement, n: number): void {
  for (const slot of queryPageSlots(host, n)) {
    const canvas = slot.querySelector("canvas");
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    slot.removeAttribute("data-painted");
  }
}

function sharpPages(lastPage: number): Set<number> {
  const C = peekPdfFilmCurrent();
  const published = peekPdfRestPages();
  if (published.length > 0) return new Set(published);
  return new Set(pdfRestPages(C, lastPage, peekPdfIntersectingPages()));
}

function blitCachedSheet(
  host: HTMLElement,
  n: number,
  page: RenderedPage,
  sheet: SheetBitmap,
  targetScale: number,
): void {
  if (!(targetScale > 0)) return;
  const dest = destSheetSize(sheet, page.fit, targetScale);
  blitSheetToSlots(
    sheet.bitmap,
    sheet.width,
    sheet.height,
    queryPageSlots(host, n),
    dest.width,
    dest.height,
  );
}

function releasePagePixels(
  host: HTMLElement,
  n: number,
  page: RenderedPage | undefined,
  lru: PdfSheetLru,
  wanted: Set<number>,
): void {
  if (lru.has(n) && wanted.has(n)) return;
  const stub = lru.peekPreview(n) ?? lru.peekRest(n);
  if (stub && page) {
    blitCachedSheet(host, n, page, stub, PDF_PREVIEW_SCALE);
    return;
  }
  zeroPageSlots(host, n);
}

export function PdfDocument({
  bytes,
  docHash = null,
  frameWidth,
  onMeasure,
  onNav,
  onThumbRenderer,
  spread = false,
  selectable = false,
  onError,
  initialPage = 0,
}: PdfDocumentProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const onNavRef = useRef(onNav);
  onNavRef.current = onNav;
  const onThumbRendererRef = useRef(onThumbRenderer);
  onThumbRendererRef.current = onThumbRenderer;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const initialPageRef = useRef(initialPage);
  initialPageRef.current = initialPage;
  useEffect(() => {
    if (initialPage >= 1) publishPdfFilmCurrent(initialPage);
  }, [initialPage]);
  const visibleRatioRef = useRef<Map<number, number>>(new Map());
  /** Per-slot ratios so two-up halves of one sheet do not un-see each other. */
  const visibleSlotRatioRef = useRef<Map<Element, number>>(new Map());
  /** The open document, shared by the layout pass and the paint pass. */
  const docRef = useRef<Awaited<
    ReturnType<typeof import("pdfjs-dist").getDocument>["promise"]
  > | null>(null);
  const taskRef = useRef<ReturnType<typeof import("pdfjs-dist").getDocument> | null>(null);
  const textLayerRef = useRef<typeof import("pdfjs-dist").TextLayer | null>(null);
  /** Pages holding a bitmap right now, and how to give it back. */
  const paintedRef = useRef<Map<number, { release: () => void; scale: number }>>(
    new Map(),
  );
  const sheetLruRef = useRef(new PdfSheetLru(PDF_REST_CACHE));
  const sessionRef = useRef(new PdfPageSession());
  const lastSettledPageRef = useRef(Math.max(1, initialPage));
  const pathFillRef = useRef<number[]>([]);
  /** Pages the viewport can currently see. */
  const visibleRef = useRef<Set<number>>(new Set());
  /** Pages the window wants painted — the visible ones, plus their neighbours. */
  const wantedRef = useRef<Set<number>>(new Set());
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const [windowTick, setWindowTick] = useState(0);
  /** One paint pump at a time — see the effect that drives it. */
  const pumpRef = useRef(false);
  const inFlightPaintRef = useRef<{
    page: number;
    target: number;
    cancel: () => void;
  } | null>(null);
  const preemptPaintIfNeededRef = useRef<() => void>(() => {});
  /** Set on unmount / reload, so in-flight paints stop touching dead nodes. */
  const disposedRef = useRef(false);
  const naturalsRef = useRef<PdfPageNatural[]>([]);
  const spreadRef = useRef(spread);
  const frameWidthRef = useRef(frameWidth);
  spreadRef.current = spread;
  frameWidthRef.current = frameWidth;

  useEffect(() => {
    setActiveSheetLru(sheetLruRef.current);
    return () => setActiveSheetLru(null);
  }, []);

  const dropSlotGpu = () => {
    for (const entry of paintedRef.current.values()) entry.release();
    paintedRef.current.clear();
  };

  const dropPaintedSession = () => {
    dropSlotGpu();
    sheetLruRef.current.clear();
    sessionRef.current.clear();
    pathFillRef.current = [];
  };

  /**
   * Open the document once. Spread / column width only relayouts from
   * cached MediaBoxes — toggling two-up used to destroy the worker task and
   * `getPage` every sheet again, which froze Kleinberg and left a half stack
   * if you toggled off mid-open.
   */
  useEffect(() => {
    let cancelled = false;
    let lent: NonNullable<typeof docRef.current> | null = null;
    disposedRef.current = false;
    // pdf.js transfers the buffer it is handed to the worker, and React may run
    // this effect twice in development — a copy keeps the prop reusable either
    // way. Uint8Array, not the raw ArrayBuffer: a transferred buffer reaches
    // the worker as zero bytes and pdf.js reports "Invalid PDF structure".
    // A detached buffer reports zero length, which is also what an empty one
    // reports — and the reader needs the same answer for both. Checked by
    // length rather than by attempting a copy, so a textbook is not duplicated
    // in memory just to ask the question.
    if (bytes.byteLength === 0) {
      onErrorRef.current?.(
        "this PDF's bytes were released before they could be drawn — pick the file again",
      );
      return () => {
        cancelled = true;
      };
    }
    naturalsRef.current = [];
    setPages([]);
    dropPaintedSession();
    lastSettledPageRef.current =
      initialPageRef.current >= 1 ? initialPageRef.current : peekPdfFilmCurrent();
    wantedRef.current = new Set();
    visibleRef.current = new Set();
    visibleRatioRef.current = new Map();
    visibleSlotRatioRef.current = new Map();
    onNavRef.current?.(null);
    resetPdfFilmPredicted();
    resetPdfPreloadPages();
    resetPdfViewPages();
    resetPdfReadingFrames();
    if (initialPageRef.current >= 1) publishPdfFilmCurrent(initialPageRef.current);
    else resetPdfFilmCurrent();

    void (async () => {
      try {
        const pdfjs = await loadPdfJs();
        // Teardown lives on the loading task, not the document — keep it. The
        // worker is passed in rather than found: `getDocument` only records
        // `task._worker` when it had to create one, and `destroy()` destroys
        // what it recorded, so leaving it to `GlobalWorkerOptions.workerPort`
        // means closing one document tears down the worker every other
        // document is still using.
        const task = pdfjs.getDocument({
          data: new Uint8Array(bytes.slice(0)),
          worker: pdfWorker(pdfjs),
          ...pdfJsDataUrls(),
          cMapPacked: true,
        });
        const doc = await task.promise;
        if (cancelled) {
          try {
            void task.destroy();
          } catch {
            /* already torn down */
          }
          return;
        }
        taskRef.current = task;
        docRef.current = doc;
        if (docHash) {
          lendPdfDocument(docHash, doc);
          lent = doc;
        }
        textLayerRef.current = pdfjs.TextLayer;

        const naturals: PdfPageNatural[] = [];
        for (let from = 1; from <= doc.numPages; from += LAYOUT_BATCH) {
          if (cancelled) return;
          const batch = [];
          for (let n = from; n < from + LAYOUT_BATCH && n <= doc.numPages; n += 1) {
            batch.push(doc.getPage(n));
          }
          const settled = await Promise.all(batch);
          if (cancelled) return;
          for (const page of settled) {
            const natural = page.getViewport({ scale: 1 });
            // Per page, not per document: a scanned plate among typeset pages
            // is a different size, and a book-wide factor would letterbox one
            // or crop the other.
            naturals.push({
              pageNumber: page.pageNumber,
              width: natural.width,
              height: natural.height,
            });
          }
          naturalsRef.current = naturals.slice();
          // First batch is enough for the open gate to see a real stack height.
          // Waiting for every getPage used to throw "did not finish opening"
          // while PdfDocument still said Opening… — Kleinberg is 432 dictionary
          // round-trips. Pause so the 250 ms settle can fire before the next
          // batch grows the stack and resets the deadline.
          setPages(
            layoutPdfPages(
              naturalsRef.current,
              frameWidthRef.current,
              spreadRef.current,
            ),
          );
          if (
            from === 1 &&
            doc.numPages > LAYOUT_BATCH &&
            (initialPageRef.current < 1 || initialPageRef.current <= LAYOUT_BATCH)
          ) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, 300);
            });
            if (cancelled) return;
          }
        }
      } catch (cause: unknown) {
        if (cancelled) return;
        onErrorRef.current?.(
          cause instanceof Error ? cause.message : "this PDF could not be opened",
        );
      }
    })();

    return () => {
      cancelled = true;
      disposedRef.current = true;
      if (lent && docHash) dropPdfDocument(docHash, lent);
      dropPaintedSession();
      naturalsRef.current = [];
      resetPdfReadingFrames();
      if (initialPageRef.current < 1) resetPdfFilmCurrent();
      resetPdfFilmPredicted();
      resetPdfPreloadPages();
      resetPdfViewPages();
      docRef.current = null;
      const task = taskRef.current;
      taskRef.current = null;
      if (task) {
        try {
          void task.destroy();
        } catch {
          /* already torn down */
        }
      }
    };
  }, [bytes, docHash]);

  /**
   * Two-up / column width: relayout from MediaBoxes already in memory.
   * Must not sit on the open effect's deps or toggle kills the document.
   */
  useLayoutEffect(() => {
    const nats = naturalsRef.current;
    if (nats.length === 0 || !docRef.current) return;
    try {
      inFlightPaintRef.current?.cancel();
    } catch {
      /* already finished */
    }
    inFlightPaintRef.current = null;
    setPages(layoutPdfPages(nats, frameWidth, spread));
    setWindowTick((tick) => tick + 1);
    wakePdfPaintPump();
  }, [frameWidth, spread]);

  /**
   * Which pages are near enough to be worth a bitmap.
   *
   * The page divs exist from layout onward whether or not they hold a picture,
   * so they are what gets observed — the window is a property of where the
   * reader is, not of what happens to be painted already.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || pages.length === 0) return;
    const slots = Array.from(host.querySelectorAll<HTMLElement>("[data-pdf-page]"));
    if (slots.length === 0) return;
    const last = pages[pages.length - 1].pageNumber;
    visibleSlotRatioRef.current = new Map();
    visibleRef.current = new Set();
    visibleRatioRef.current = new Map();

    /** Sliding 1× ring around live C — not the flick-end guess. */
    const rebuild = () => {
      const wanted = new Set(
        pdfOuterPages(peekPdfFilmCurrent(), last, PDF_PREVIEW_RADIUS),
      );
      const before = wantedRef.current;
      const same =
        before.size === wanted.size && [...wanted].every((n) => before.has(n));
      if (same) return;
      wantedRef.current = wanted;
      setWindowTick((tick) => tick + 1);
    };

    const lastPublished = { count: -1, current: -1 };
    const publishNav = () => {
      const current = peekPdfFilmCurrent();
      // Filmstrip / rest expand from camera C (hole center), not IO's top sheet.
      if (isDocCameraLive()) return;
      if (!pdfNavShouldPublish(lastPublished, { count: last, current })) return;
      lastPublished.count = last;
      lastPublished.current = current;
      const aspects = pages.map((page) =>
        page.height > 0 ? page.sheetWidth / page.height : 612 / 792,
      );
      onNavRef.current?.({ count: last, current, aspects });
    };

    rebuild();
    publishNav();

    if (typeof IntersectionObserver !== "function") {
      // No observer: paint everything, as this component always used to. Worse
      // on a textbook, but a working reader beats a blank one.
      wantedRef.current = new Set(pages.map((page) => page.pageNumber));
      setWindowTick((tick) => tick + 1);
      return () => {
        onNavRef.current?.(null);
      };
    }

    const notePath = () => {
      const current = lastPublished.current > 0 ? lastPublished.current : 1;
      const from = lastSettledPageRef.current;
      if (current === from) return;
      lastSettledPageRef.current = current;
      if (!PDF_PATH_FILL) return;
      pathFillRef.current = sessionPathPages(from, current, last, PDF_SESSION_CAP).filter(
        (n) => !wantedRef.current.has(n) && !sessionRef.current.has(n),
      );
      if (pathFillRef.current.length > 0) setWindowTick((tick) => tick + 1);
    };

    const flushAfterCoast = () => {
      rebuild();
      publishNav();
    };

    const applySlotVisibility = () => {
      const nextPages = new Set<number>();
      const nextRatios = new Map<number, number>();
      for (const [el, ratio] of visibleSlotRatioRef.current) {
        const n = Number((el as HTMLElement).dataset.pdfPage);
        if (!Number.isFinite(n)) continue;
        nextPages.add(n);
        nextRatios.set(n, Math.max(nextRatios.get(n) ?? 0, ratio));
      }
      visibleRef.current = nextPages;
      visibleRatioRef.current = nextRatios;
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleSlotRatioRef.current.set(entry.target, entry.intersectionRatio);
          } else {
            visibleSlotRatioRef.current.delete(entry.target);
          }
        }
        applySlotVisibility();
        publishNav();
        /*
         * A live flick already has the compositor moving the whole stack.
         * Rebuilding the paint window mid-coast is the hitch. Film current
         * already published above without Workspace setState.
         */
        if (isDocCameraLive()) return;
        rebuild();
      },
      { rootMargin: PAGE_VISIBLE_MARGIN },
    );
    for (const slot of slots) observer.observe(slot);
    let idlePathTimer = 0;
    let lastBlitLogAt = 0;
    const blitOuterFromLru = () => {
      const C = peekPdfFilmCurrent();
      const outer = pdfOuterPages(C, last, PDF_PREVIEW_RADIUS);
      wantedRef.current = new Set(outer);
      const rest = sharpPages(last);
      const lru = sheetLruRef.current;
      const live = isDocCameraLive();
      const hole = peekPdfIntersectingPages();
      const blitIds = [
        ...new Set([...outer, ...hole, ...peekPdfPreloadPages(), C]),
      ];
      if (live) {
        const now = performance.now();
        if (now - lastBlitLogAt >= 250) {
          lastBlitLogAt = now;
          console.log(
            `[lc:pdf-blit] C=${C} live=1 blit=${blitIds.length} outer=${outer.length}`,
          );
        }
      }
      for (const n of blitIds) {
        const sheet = lru.peek(n) ?? lru.get(n);
        const page = pages.find((entry) => entry.pageNumber === n);
        if (!sheet || !page) continue;
        const target = rest.has(n) ? PDF_REST_SCALE : PDF_PREVIEW_SCALE;
        blitCachedSheet(host, n, page, sheet, target);
        paintedRef.current.set(n, {
          scale: target,
          release: () => {
            releasePagePixels(host, n, page, lru, wantedRef.current);
          },
        });
      }
      for (const n of [...paintedRef.current.keys()]) {
        if (wantedRef.current.has(n)) continue;
        paintedRef.current.get(n)?.release();
        paintedRef.current.delete(n);
      }
    };
    blitOuterFromLru();
    const unsubFilm = subscribePdfFilmCurrent(() => {
      if (!isDocCameraLive()) blitOuterFromLru();
      preemptPaintIfNeededRef.current();
      if (isDocCameraLive()) return;
      rebuild();
    });
    const unsubView = subscribePdfViewPages(() => {
      blitOuterFromLru();
      preemptPaintIfNeededRef.current();
      if (isDocCameraLive()) return;
      setWindowTick((tick) => tick + 1);
    });
    const unsubPreload = subscribePdfPreloadPages(() => {
      preemptPaintIfNeededRef.current();
      if (!pumpRef.current) setWindowTick((tick) => tick + 1);
    });
    const unsubLive = subscribeDocCameraLive((live) => {
      if (live) {
        if (idlePathTimer) window.clearTimeout(idlePathTimer);
        idlePathTimer = 0;
        return;
      }
      blitOuterFromLru();
      setWindowTick((tick) => tick + 1);
      flushAfterCoast();
      idlePathTimer = window.setTimeout(() => {
        idlePathTimer = 0;
        if (isDocCameraLive()) return;
        notePath();
      }, msUntilCameraIdleTeardown());
    });
    return () => {
      if (idlePathTimer) window.clearTimeout(idlePathTimer);
      unsubFilm();
      unsubView();
      unsubPreload();
      unsubLive();
      observer.disconnect();
      onNavRef.current?.(null);
    };
  }, [pages]);

  useEffect(() => {
    setPdfReadingFrames(
      pages.length === 0
        ? []
        : pdfStackFrames(pages, spread, PAGE_GAP, PDF_DOC_PAD_TOP),
    );
  }, [pages, spread]);

  useEffect(() => {
    onThumbRendererRef.current?.(null);
    return () => onThumbRendererRef.current?.(null);
  }, [pages]);

  /**
   * Paint what is in the window; release what has left it.
   *
   * A pump rather than a fresh pass per window change. Scrolling moves the
   * window many times a second, and a pass that cancelled its predecessor
   * meant every page's render was abandoned a few milliseconds in — the reader
   * scrolled through a book that never finished drawing anything. The pump
   * runs one page at a time and re-reads the window between pages instead, so
   * a change of mind costs at most the page in flight, and pages that have
   * scrolled away are dropped from the queue before they are ever started.
   *
   * Serialised for the same reason it is not cancelled: several `render` calls
   * at once contend for the one worker and for main-thread compositing, and
   * the page the reader is actually looking at arrives later, not sooner.
   */
  useEffect(() => {
    const host = hostRef.current;
    const doc = docRef.current;
    const TextLayer = textLayerRef.current;
    if (!host || !doc || !TextLayer || pages.length === 0) return;
    const lastLaidOut = pages[pages.length - 1]?.pageNumber ?? 0;
    if (pdfPaintShouldWaitForLanding(peekPdfFilmCurrent(), lastLaidOut)) return;
    if (pumpRef.current) return;

    const dropSessionText = (pagesToDrop: number[]) => {
      for (const gone of pagesToDrop) {
        for (const node of host.querySelectorAll<HTMLElement>(
          `[data-pdf-page="${gone}"]`,
        )) {
          const text = node.querySelector<HTMLElement>(".lc-pdf-text");
          if (text) text.textContent = "";
          node.removeAttribute("data-painted");
        }
      }
    };

    const pageOut = async (
      n: number,
      keepText = true,
      forceCap = false,
    ): Promise<boolean> => {
      if (isDocCameraLive()) return false;
      if (!forceCap && !isCameraIdleForTeardown()) return false;
      const slots = [
        ...host.querySelectorAll<HTMLElement>(`[data-pdf-page="${n}"]`),
      ];
      if (slots.length === 0) return true;
      for (const slot of slots) {
        const canvas = slot.querySelector("canvas");
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
        slot.removeAttribute("data-painted");
        if (!keepText) {
          const text = slot.querySelector<HTMLElement>(".lc-pdf-text");
          if (text) text.textContent = "";
        }
      }
      return true;
    };

    const extrasFarthestFirst = (): number[] => {
      const extras = [...paintedRef.current.keys()].filter(
        (n) => !wantedRef.current.has(n),
      );
      const C = peekPdfFilmCurrent();
      return extras.sort((a, b) => Math.abs(b - C) - Math.abs(a - C));
    };

    const archiveDropped = (dropped: DroppedSheet[]) => {
      for (const item of dropped) {
        const stub = sheetLruRef.current.peekPreview(item.page);
        const entry = pagesRef.current.find((page) => page.pageNumber === item.page);
        if (stub && entry) {
          blitCachedSheet(host, item.page, entry, stub, PDF_PREVIEW_SCALE);
        } else if (!wantedRef.current.has(item.page)) {
          zeroPageSlots(host, item.page);
          paintedRef.current.delete(item.page);
        }
        void (async () => {
          if (!PDF_PAGEFILE || isDocCameraLive()) {
            releaseSheet(item.sheet);
            return;
          }
          const png = await captureSheetPng(item.sheet, () => isDocCameraLive());
          releaseSheet(item.sheet);
          if (!png || disposedRef.current) return;
          dropSessionText(sessionRef.current.put(item.page, png));
        })();
      }
    };

    const paintOne = async (n: number, targetOverride?: number): Promise<void> => {
      const entry = pagesRef.current.find((page) => page.pageNumber === n);
      const slots = queryPageSlots(host, n);
      if (!entry || slots.length === 0) return;

      const last = pagesRef.current.at(-1)?.pageNumber ?? 1;
      const C = peekPdfFilmCurrent();
      const outer = new Set(pdfOuterPages(C, last, PDF_PREVIEW_RADIUS));
      const rest = sharpPages(last);
      let paintScale =
        targetOverride != null
          ? targetOverride
          : pdfPageTargetScale(n, rest, outer);
      if (!(paintScale > 0)) paintScale = PDF_PREVIEW_SCALE;
      const placeholder = sheetLruRef.current.peek(n);
      if (placeholder) {
        blitCachedSheet(
          host,
          n,
          entry,
          placeholder,
          paintScale > PDF_PREVIEW_SCALE + 1e-9
            ? PDF_PREVIEW_SCALE
            : paintScale,
        );
      }
      const live = isDocCameraLive();
      if (live && paintScale > PDF_PREVIEW_SCALE + 1e-9) {
        const cached = sheetLruRef.current.get(n);
        if (cached) {
          blitCachedSheet(host, n, entry, cached, paintScale);
          paintedRef.current.set(n, {
            scale: paintScale,
            release: () => {
              releasePagePixels(host, n, entry, sheetLruRef.current, wantedRef.current);
            },
          });
          return;
        }
        const hole = pdfPaintHole(C, peekPdfIntersectingPages());
        if (!hole.includes(n)) return;
        paintScale = PDF_PREVIEW_SCALE;
      }
      const prev = paintedRef.current.get(n);
      let paint: { cancel: () => void; promise: Promise<void> } | null = null;
      let done = false;
      let aborted = false;
      inFlightPaintRef.current = {
        page: n,
        target: paintScale,
        cancel: () => {
          aborted = true;
          try {
            paint?.cancel();
          } catch {
            /* already finished */
          }
        },
      };
      const stopLive = subscribeDocCameraLive((nowLive) => {
        if (!nowLive) return;
        if (paintScale <= PDF_PREVIEW_SCALE + 1e-9) return;
        aborted = true;
        try {
          paint?.cancel();
        } catch {
          /* already finished */
        }
      });
      const commitSheet = (sheet: SheetBitmap, target = paintScale) => {
        const blitScale = target > 0 ? target : PDF_PREVIEW_SCALE;
        blitCachedSheet(host, n, entry, sheet, blitScale);
        paintedRef.current.set(n, {
          scale: blitScale,
          release: () => {
            try {
              paint?.cancel();
            } catch {
              /* already finished */
            }
            releasePagePixels(host, n, entry, sheetLruRef.current, wantedRef.current);
          },
        });
        done = true;
      };
      const rememberScratch = async (src: HTMLCanvasElement, pixelScale: number) => {
        const sheet = await snapshotSheet(src, pixelScale);
        if (disposedRef.current) return sheet;
        sessionRef.current.delete(n);
        const dropped = sheetLruRef.current.put(n, sheet, C, paintScale);
        archiveDropped(dropped);
        return sheet;
      };
      const fillText = async (
        pdfPage: Awaited<ReturnType<typeof doc.getPage>>,
        content: Awaited<
          ReturnType<Awaited<ReturnType<typeof doc.getPage>>["getTextContent"]>
        >,
      ) => {
        for (const slot of slots) {
          if (disposedRef.current || isDocCameraLive()) return;
          const textHost = slot.querySelector<HTMLElement>(".lc-pdf-text");
          const spreadHost =
            slot.querySelector<HTMLElement>(".lc-pdf-spread") ?? slot;
          if (!textHost) continue;
          textHost.textContent = "";
          const layer = new TextLayer({
            textContentSource: {
              ...content,
              items: content.items.slice(),
            },
            container: textHost,
            viewport: pdfPage.getViewport({ scale: entry.fit }),
          });
          await layer.render();
          if (disposedRef.current || isDocCameraLive()) return;
          alignTextLayerToGlyphs(
            spreadHost,
            layer.textDivs,
            content.items,
            entry.fit,
          );
        }
      };

      try {
        const cached = sheetLruRef.current.get(n);
        if (cached && !pageNeedsDecode(entry.fit, paintScale, cached.pixelScale)) {
          commitSheet(cached);
          if (isDocCameraLive()) return;
          const firstText = slots[0]?.querySelector(".lc-pdf-text");
          if (firstText && firstText.childNodes.length > 0) return;
          const pdfPage = await doc.getPage(n);
          if (disposedRef.current || isDocCameraLive()) return;
          const content = await pdfPage.getTextContent();
          if (disposedRef.current || isDocCameraLive()) return;
          await fillText(pdfPage, content);
          return;
        }

        const paged = sessionRef.current.get(n);
        if (paged && !isDocCameraLive()) {
          const restored = await restoreSheetPng(paged);
          if (disposedRef.current) return;
          if (restored) {
            sessionRef.current.delete(n);
            const restoredTarget = pageNeedsDecode(
              entry.fit,
              PDF_REST_SCALE,
              restored.pixelScale,
            )
              ? PDF_PREVIEW_SCALE
              : PDF_REST_SCALE;
            const dropped = sheetLruRef.current.put(n, restored, C, restoredTarget);
            archiveDropped(dropped);
            if (!pageNeedsDecode(entry.fit, paintScale, restored.pixelScale)) {
              commitSheet(restored);
              const firstText = slots[0]?.querySelector(".lc-pdf-text");
              if (firstText && firstText.childNodes.length > 0) return;
              const pdfPage = await doc.getPage(n);
              if (disposedRef.current || isDocCameraLive()) return;
              const content = await pdfPage.getTextContent();
              if (disposedRef.current || isDocCameraLive()) return;
              await fillText(pdfPage, content);
              return;
            }
          }
        }

        if (isDocCameraLive() && paintScale > PDF_PREVIEW_SCALE + 1e-9) return;
        if (aborted) return;
        const pdfPage = await doc.getPage(n);
        if (disposedRef.current || aborted) return;
        if (isDocCameraLive() && paintScale > PDF_PREVIEW_SCALE + 1e-9) return;
        const viewport = pdfPage.getViewport({ scale: entry.fit * paintScale });
        const scratch = document.createElement("canvas");
        scratch.width = Math.round(viewport.width);
        scratch.height = Math.round(viewport.height);
        const scratchCtx = scratch.getContext("2d");
        if (!scratchCtx) return;
        await yieldToInput();
        if (disposedRef.current || aborted) return;
        if (isDocCameraLive() && paintScale > PDF_PREVIEW_SCALE + 1e-9) return;
        paint = pdfPage.render({
          canvas: scratch,
          canvasContext: scratchCtx,
          viewport,
        });
        await paint.promise;
        if (disposedRef.current || aborted) return;
        if (!isDocCameraLive()) {
          const content = await pdfPage.getTextContent();
          if (disposedRef.current || isDocCameraLive()) return;
          await fillText(pdfPage, content);
          if (disposedRef.current) return;
        }
        const sheet = await rememberScratch(scratch, entry.fit * paintScale);
        if (disposedRef.current) return;
        commitSheet(sheet);
      } catch (cause: unknown) {
        if (disposedRef.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!/cancel|abort|worker.*(destroy|terminat|not running)/i.test(message)) {
          onErrorRef.current?.(message);
        }
      } finally {
        stopLive();
        if (inFlightPaintRef.current?.page === n) inFlightPaintRef.current = null;
        if (!done) {
          if (prev) paintedRef.current.set(n, prev);
          else paintedRef.current.delete(n);
        }
      }
    };

    const currentQueue = () => {
      const last = pagesRef.current.at(-1)?.pageNumber ?? 1;
      const C = peekPdfFilmCurrent();
      const outerList = pdfOuterPages(C, last, PDF_PREVIEW_RADIUS);
      const outer = new Set(outerList);
      wantedRef.current = outer;
      const rest = sharpPages(last);
      const visibleRaw = peekPdfIntersectingPages();
      const visible = pdfPaintHole(C, visibleRaw);
      const fitOf = (n: number) =>
        pagesRef.current.find((page) => page.pageNumber === n)?.fit ?? 0;
      const scaleOf = (n: number) => sheetLruRef.current.scale(n);
      const preload = peekPdfPreloadPages();
      let queue = pdfDecodeQueue(C, last, rest, outer, visible, scaleOf, fitOf, preload);
      if (isDocCameraLive()) {
        const hole = new Set(visible);
        const ahead = new Set(preload);
        queue = queue.filter(
          (item) =>
            item.target === PDF_PREVIEW_SCALE &&
            (hole.has(item.page) || ahead.has(item.page)),
        );
      }
      return { outerList, rest, queue };
    };

    preemptPaintIfNeededRef.current = () => {
      const flight = inFlightPaintRef.current;
      if (!flight) return;
      const { queue, rest } = currentQueue();
      const head = queue[0];
      if (!head) return;
      const C = peekPdfFilmCurrent();
      const hole = new Set(pdfPaintHole(C, peekPdfIntersectingPages()));
      if (pdfShouldPreempt(flight, head, C, hole, rest)) {
        try {
          flight.cancel();
        } catch {
          /* already finished */
        }
      }
    };

    const blitRing = (outerList: number[], rest: Set<number>) => {
      for (const n of outerList) {
        const sheet = sheetLruRef.current.get(n);
        const entry = pagesRef.current.find((page) => page.pageNumber === n);
        if (!sheet || !entry) continue;
        const target = rest.has(n) ? PDF_REST_SCALE : PDF_PREVIEW_SCALE;
        blitCachedSheet(host, n, entry, sheet, target);
        paintedRef.current.set(n, {
          scale: target,
          release: () => {
            releasePagePixels(host, n, entry, sheetLruRef.current, wantedRef.current);
          },
        });
      }
    };

    pumpRef.current = true;
    void (async () => {
      try {
        for (;;) {
          if (disposedRef.current) return;

          const lastLaidOut = pagesRef.current.at(-1)?.pageNumber ?? 0;
          if (pdfPaintShouldWaitForLanding(peekPdfFilmCurrent(), lastLaidOut)) return;

          const { outerList, rest, queue } = currentQueue();
          blitRing(
            [
              ...new Set([
                ...outerList,
                ...pdfPaintHole(peekPdfFilmCurrent(), peekPdfIntersectingPages()),
                ...peekPdfPreloadPages(),
              ]),
            ],
            rest,
          );

          const idle = isCameraIdleForTeardown();
          const overCap = paintedRef.current.size > MAX_LIVE_CANVASES;
          if (idle || overCap) {
            for (const n of extrasFarthestFirst()) {
              if (!idle && paintedRef.current.size <= MAX_LIVE_CANVASES) break;
              if (isDocCameraLive()) break;
              if (disposedRef.current) return;
              if (wantedRef.current.has(n)) continue;
              if (await pageOut(n, true, overCap && !idle)) {
                paintedRef.current.delete(n);
              }
              if (disposedRef.current) return;
            }
          }

          if (queue.length > 0) {
            const batch = queue.slice(0, PAINT_INFLIGHT);
            await Promise.all(batch.map((item) => paintOne(item.page, item.target)));
            continue;
          }

          if (isDocCameraLive()) {
            await waitForPaintSignal();
            continue;
          }

          while (
            pathFillRef.current.length > 0 &&
            (wantedRef.current.has(pathFillRef.current[0]!) ||
              sessionRef.current.has(pathFillRef.current[0]!) ||
              sheetLruRef.current.has(pathFillRef.current[0]!))
          ) {
            pathFillRef.current.shift();
          }
          const next = pathFillRef.current.shift();
          if (next == null) return;
          if (sessionRef.current.size() >= PDF_SESSION_CAP) {
            pathFillRef.current = [];
            return;
          }
          if (isDocCameraLive()) continue;
          if (disposedRef.current) return;
          await paintOne(next, PDF_PREVIEW_SCALE);
          if (disposedRef.current) return;
        }
      } finally {
        pumpRef.current = false;
        if (!disposedRef.current) {
          const pendingHot = currentQueue().queue.length > 0;
          const pendingPath = pathFillRef.current.some(
            (n) =>
              !wantedRef.current.has(n) &&
              !sessionRef.current.has(n) &&
              !sheetLruRef.current.has(n),
          );
          if (pendingHot || pendingPath) setWindowTick((tick) => tick + 1);
        }
      }
    })();
  }, [pages, windowTick]);

  // Height is reported from the laid-out stack rather than summed from the page
  // sizes: the gaps, and any rounding the browser does, belong in the number the
  // page frame grows to, or ink at the bottom of the last page gets clipped.
  useEffect(() => {
    const node = hostRef.current;
    if (!node || pages.length === 0) return;
    const report = () => {
      const height = node.scrollHeight;
      if (height > 0) onMeasureRef.current?.(height);
    };
    report();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [pages]);

  return (
    <div
      ref={hostRef}
      className="lc-pdf-doc"
      aria-hidden={selectable ? undefined : true}
      style={{ gap: PAGE_GAP }}
    >
      {pages.flatMap((page) =>
        pdfReadingSlots(page, spread).map((slot) => (
          <div
            key={slot.key}
            className="lc-pdf-page"
            data-pdf-page={page.pageNumber}
            data-pdf-half={slot.half}
            /*
              Each page is its own offset space — see `docAnchors`. On a textbook
              that is the difference between resolving a mark on page 900 by
              walking one page and walking nine hundred, and it is what lets a
              footnote say which page it is on when the coach is told about it.
              Two-up right half is a second root so quotes land on the visible
              clip, not the left slot's overflow.
            */
            data-doc-scope={
              slot.half === "right" ? `p${page.pageNumber}r` : `p${page.pageNumber}`
            }
            style={
              {
                width: page.width,
                height: page.height,
                // pdf.js positions its text spans against this.
                "--scale-factor": page.fit,
                "--total-scale-factor": page.fit,
              } as CSSProperties
            }
          >
            <canvas className="lc-pdf-canvas" />
            {/*
              Each page's text layer is its own block, which is what puts a break
              between page one's last word and page two's first in the character
              stream — see `docAnchors`. Without one a quote that ran off the
              bottom of a page came back as two sentences fused at the seam.
              Two-up: the spread is the full sheet; overflow on the slot clips
              to one book page. Right half is shifted left by one column.
            */}
            <div
              className="lc-pdf-spread"
              style={{
                width: page.sheetWidth,
                transform:
                  slot.half === "right" ? `translateX(-${page.width}px)` : undefined,
              }}
            >
              <div className="lc-pdf-text textLayer" />
            </div>
          </div>
        )),
      )}
      {pages.length === 0 && <p className="lc-pdf-loading">Opening…</p>}
    </div>
  );
}

function waitForPaintSignal(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let skipView = true;
    let skipFilm = true;
    let skipPreload = true;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubLive();
      unsubView();
      unsubFilm();
      unsubPreload();
      unsubWake();
      resolve();
    };
    const unsubLive = subscribeDocCameraLive(() => finish());
    const unsubView = subscribePdfViewPages(() => {
      if (skipView) return;
      finish();
    });
    const unsubFilm = subscribePdfFilmCurrent(() => {
      if (skipFilm) return;
      finish();
    });
    const unsubPreload = subscribePdfPreloadPages(() => {
      if (skipPreload) return;
      finish();
    });
    const unsubWake = subscribePdfPaintWake(() => finish());
    skipView = false;
    skipFilm = false;
    skipPreload = false;
  });
}

/**
 * Visible rest is 2×; neighbours stay 1×. Empty visible (open, before the
 * observer) uses rest so the landing page is not a preview.
 */
export function pdfPagePaintScale(
  page?: number,
  visible?: Iterable<number>,
  rest = PDF_REST_SCALE,
  preview = PDF_PREVIEW_SCALE,
): number {
  if (page == null || visible == null) return rest;
  const onScreen = visible instanceof Set ? visible : new Set(visible);
  if (onScreen.size === 0) return rest;
  return onScreen.has(page) ? rest : preview;
}

function pdfReadingSlots(
  page: RenderedPage,
  spread: boolean,
): { half: "left" | "right"; key: string }[] {
  if (!spread) return [{ half: "left", key: String(page.pageNumber) }];
  return [
    { half: "left", key: `${page.pageNumber}-L` },
    { half: "right", key: `${page.pageNumber}-R` },
  ];
}

/**
 * The pages worth holding a bitmap for, given what is on screen.
 *
 * Split out so the rule can be asserted without a browser: it is the one piece
 * of the window that decides how much memory a book costs, and "prev, current,
 * next" is easy to get subtly wrong at the ends of the document.
 */
export function windowedPages(
  visible: Iterable<number>,
  lastPage: number,
  radius = PAGE_WINDOW_RADIUS,
  focus = 1,
): number[] {
  const wanted = new Set<number>();
  for (const n of visible) {
    for (let d = -radius; d <= radius; d += 1) {
      const near = n + d;
      if (near >= 1 && near <= lastPage) wanted.add(near);
    }
  }
  // Nothing visible yet — paint around the restored session page, not page 1.
  if (wanted.size === 0) {
    const c = Math.max(1, Math.min(lastPage, Math.round(focus) || 1));
    for (let d = -radius; d <= radius; d += 1) {
      const near = c + d;
      if (near >= 1 && near <= lastPage) wanted.add(near);
    }
  }
  return [...wanted].sort((a, b) => a - b);
}

/**
 * Skip filmstrip / Workspace updates when the page under the camera has not
 * changed. IntersectionObserver fires on every ratio tweak during a pan; a new
 * `aspects` array each time was a full Workspace render per sample.
 */
export function pdfNavShouldPublish(
  prev: { count: number; current: number } | null,
  next: { count: number; current: number },
): boolean {
  if (prev == null) return true;
  return prev.count !== next.count || prev.current !== next.current;
}

/**
 * Order the paint pump should fill the window.
 *
 * The pump used to walk page numbers ascending. Scrolling *down* the book
 * already had the previous neighbour painted from the last window, so the next
 * unpainted page was the one on screen. Scrolling *up* had neither the current
 * page nor the neighbour above painted — and ascending order spent a full
 * render on the off-screen neighbour before the page the reader was looking at.
 * That is the "annotations arrive late when scrolling up" report on a PDF: the
 * ink overlay was ready, the page under it was not.
 *
 * Distance from the visible focus first; ascending only to break ties.
 */
export function paintOrder(
  wanted: Iterable<number>,
  visible: Iterable<number>,
): number[] {
  const onScreen = [...visible];
  const focus =
    onScreen.length > 0
      ? onScreen.reduce((sum, n) => sum + n, 0) / onScreen.length
      : null;
  return [...wanted].sort((a, b) => {
    if (focus == null) return a - b;
    const da = Math.abs(a - focus);
    const db = Math.abs(b - focus);
    if (da !== db) return da - db;
    return a - b;
  });
}

/** Total scene height of a stack of pages — the measure a test can assert. */
export function pdfStackHeight(
  pages: readonly { height: number }[],
  gap = PAGE_GAP,
  spread = false,
): number {
  if (pages.length === 0) return 0;
  const slots = spread ? pages.flatMap((page) => [page, page]) : pages;
  return (
    slots.reduce((total, page) => total + page.height, 0) + gap * (slots.length - 1)
  );
}
