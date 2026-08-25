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
 * already drawn on it. {@link PDF_RENDER_SCALE} buys the resolution instead,
 * once.
 *
 * Only the pages near the reader are painted. Every page is *laid out* — the
 * stack has to be its true height or the frame the ink is clipped to ends
 * before the book does — but a laid-out page is a div with a size, while a
 * painted one is a bitmap: at a 760px column and 2× supersampling that is
 * roughly 12 MB of canvas each, so a 1500-page textbook painted eagerly is
 * about 18 GB. Time is not the problem here; memory is. A small live window
 * holds GPU canvases; pages that leave it compress into a session pagefile
 * (lossless PNG of the *already decoded* pixels). Scroll back inflates that
 * PNG. It does not run JBIG2 / JPX / path raster again.
 *
 * The text layer stays in the DOM while the bitmap pages out — footnotes and
 * quotes measure those spans, not the picture. Only an LRU drop from the
 * pagefile clears the spans (the bitmap is gone, so they would be a lie).
 */

import { type CSSProperties, useEffect, useRef, useState } from "react";

import { isDocCameraLive, subscribeDocCameraLive } from "../canvas/docSelectionGesture";
import { yieldToInput } from "../util/cameraBusy";
import type { PdfThumbRenderer } from "./pdfFilm";
import {
  captureCanvasPng,
  PDF_HOT_RADIUS,
  PDF_SESSION_CAP,
  PdfPageSession,
  restoreCanvasPng,
  sessionPathPages,
} from "./pdfPageSession";
import { dropPdfDocument, lendPdfDocument } from "./pdfOpenDocs";
import { alignTextLayerToGlyphs } from "../util/pdfTextFit";

/**
 * Supersampling of the page bitmap relative to its scene size.
 *
 * Two matches the usual device-pixel-ratio ceiling on these tablets — it is
 * screen pixels, not a pinch-zoom mipmap. The board can pinch (cap 1.75) but
 * reading is width-fit; we do not bake a thumb / 1× / 2× ladder, and we do
 * not re-render a page at 2× after it has already decoded at 1×. Neighbours
 * use the same scale as the focus page so scrolling onto them is not a second
 * trip through JBIG2.
 */
const PDF_RENDER_SCALE = 2;

/** Gap between pages in scene units — a page break you can see, not a chasm. */
const PAGE_GAP = 18;

/**
 * A little slack around the viewport when deciding which pages are on screen.
 *
 * Deliberately small. The window is measured in *pages*, not in screens — see
 * {@link PAGE_WINDOW_RADIUS} — because at a width-fit zoom one page can be two
 * screens tall, and a margin expressed in viewports would then mean "half of
 * the page you are on".
 */
const PAGE_VISIBLE_MARGIN = "20% 0px";

/**
 * Live GPU canvases: current page ± {@link PDF_HOT_RADIUS}. Scroll one sheet
 * down: +1 into the window, −1 compressed into the session pagefile. Scroll
 * back: restore the PNG. Path-fill covers TOC → chapter jumps the live ring
 * cannot keep.
 */
export { PDF_HOT_RADIUS, PDF_SESSION_CAP } from "./pdfPageSession";

const PAGE_WINDOW_RADIUS = PDF_HOT_RADIUS;

/**
 * How many page bitmaps the pump may decode at once.
 *
 * The window is filled in paint-order (on-screen first), but a scanned page's
 * JBIG2 decode can outlast a flick to the next sheet. Two in flight lets a
 * neighbour start while the focus page is still rendering, without stacking
 * a full ring of 12 MB canvases at the same moment.
 */
const PAINT_INFLIGHT = 2;

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
  /** Scroll mode: the text layer answers the pointer so quotes can be picked. */
  selectable?: boolean;
  onError?: (message: string) => void;
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
  /** Natural-size → frame-width factor for this page. */
  fit: number;
  width: number;
  height: number;
}

export function PdfDocument({
  bytes,
  docHash = null,
  frameWidth,
  onMeasure,
  onNav,
  onThumbRenderer,
  selectable = false,
  onError,
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
  const visibleRatioRef = useRef<Map<number, number>>(new Map());
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
  const sessionRef = useRef(new PdfPageSession());
  const lastSettledPageRef = useRef(1);
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
  /** Set on unmount / reload, so in-flight paints stop touching dead nodes. */
  const disposedRef = useRef(false);

  /**
   * Open the document and lay every page out — sizes only, no bitmaps.
   *
   * The stack must be its true height before anything is painted: the page
   * frame grows to it, the pan clamp follows the frame, and ink at the bottom
   * of the last page is clipped by whatever the frame says.
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
    setPages([]);
    paintedRef.current.clear();
    sessionRef.current.clear();
    pathFillRef.current = [];
    lastSettledPageRef.current = 1;
    wantedRef.current = new Set();
    visibleRef.current = new Set();
    visibleRatioRef.current = new Map();
    onNavRef.current?.(null);

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

        const laid: RenderedPage[] = [];
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
            const fit = natural.width > 0 ? frameWidth / natural.width : 1;
            const viewport = page.getViewport({ scale: fit });
            laid.push({
              pageNumber: page.pageNumber,
              fit,
              width: Math.round(viewport.width),
              height: Math.round(viewport.height),
            });
          }
          // First batch is enough for the open gate to see a real stack height.
          // Waiting for every getPage used to throw "did not finish opening"
          // while PdfDocument still said Opening… — Kleinberg is 432 dictionary
          // round-trips. Pause so the 250 ms settle can fire before the next
          // batch grows the stack and resets the deadline.
          setPages(laid.slice());
          if (from === 1 && doc.numPages > LAYOUT_BATCH) {
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
      for (const entry of paintedRef.current.values()) entry.release();
      paintedRef.current.clear();
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
  }, [bytes, docHash, frameWidth]);

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

    /** Sliding live window — session pagefile holds the rest of this visit. */
    const rebuild = () => {
      const wanted = new Set(windowedPages(visibleRef.current, last, PDF_HOT_RADIUS));
      const before = wantedRef.current;
      const same =
        before.size === wanted.size && [...wanted].every((n) => before.has(n));
      if (same) return;
      wantedRef.current = wanted;
      setWindowTick((tick) => tick + 1);
    };

    const lastPublished = { count: -1, current: -1 };
    const publishNav = () => {
      const ratios = visibleRatioRef.current;
      let current = 1;
      let best = -1;
      for (const [page, ratio] of ratios) {
        if (ratio > best || (ratio === best && page < current)) {
          best = ratio;
          current = page;
        }
      }
      if (best < 0 && visibleRef.current.size > 0) {
        current = Math.min(...visibleRef.current);
      }
      if (!pdfNavShouldPublish(lastPublished, { count: last, current })) return;
      lastPublished.count = last;
      lastPublished.current = current;
      const aspects = pages.map((page) =>
        page.height > 0 ? page.width / page.height : 612 / 792,
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
      return () => onNavRef.current?.(null);
    }

    const notePath = () => {
      const current = lastPublished.current > 0 ? lastPublished.current : 1;
      const from = lastSettledPageRef.current;
      if (current === from) return;
      pathFillRef.current = sessionPathPages(from, current, last, PDF_SESSION_CAP).filter(
        (n) => !wantedRef.current.has(n) && !sessionRef.current.has(n),
      );
      lastSettledPageRef.current = current;
      if (pathFillRef.current.length > 0) setWindowTick((tick) => tick + 1);
    };

    const flushAfterCoast = () => {
      rebuild();
      publishNav();
      notePath();
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.pdfPage);
          if (!Number.isFinite(n)) continue;
          if (entry.isIntersecting) {
            visibleRef.current.add(n);
            visibleRatioRef.current.set(n, entry.intersectionRatio);
          } else {
            visibleRef.current.delete(n);
            visibleRatioRef.current.delete(n);
          }
        }
        /*
         * A live flick already has the compositor moving the whole stack.
         * Rebuilding the paint window or publishing nav (Workspace setState +
         * filmstrip scrollIntoView) invalidates that layer mid-coast — the same
         * ~30fps chop footnote placement used to cause. Keep the sets current;
         * apply them when the camera settles.
         */
        if (isDocCameraLive()) return;
        rebuild();
        publishNav();
        notePath();
      },
      { rootMargin: PAGE_VISIBLE_MARGIN },
    );
    for (const slot of slots) observer.observe(slot);
    const unsubLive = subscribeDocCameraLive((live) => {
      if (live) return;
      flushAfterCoast();
    });
    return () => {
      unsubLive();
      observer.disconnect();
      onNavRef.current?.(null);
    };
  }, [pages]);

  /**
   * Hand the filmstrip a renderer that uses this document, not a second load.
   *
   * Low scale, JPEG, throwaway canvas — the scene paint still owns the page
   * slots. Cancelled when the file changes or this tree unmounts.
   */
  useEffect(() => {
    if (pages.length === 0) {
      onThumbRendererRef.current?.(null);
      return;
    }
    const last = pages.length;
    const render: PdfThumbRenderer = async (pageNumber) => {
      const doc = docRef.current;
      if (!doc || disposedRef.current) return null;
      if (pageNumber < 1 || pageNumber > last) return null;
      try {
        const page = await doc.getPage(pageNumber);
        if (disposedRef.current) return null;
        const natural = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const targetW = 56 * dpr;
        const scale = natural.width > 0 ? targetW / natural.width : 0.12;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return null;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (disposedRef.current) return null;
        return canvas.toDataURL("image/jpeg", 0.62);
      } catch {
        return null;
      }
    };
    onThumbRendererRef.current?.(render);
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
    if (pumpRef.current) return;

    const dropSessionText = (pagesToDrop: number[]) => {
      for (const gone of pagesToDrop) {
        const node = host.querySelector<HTMLElement>(`[data-pdf-page="${gone}"]`);
        const text = node?.querySelector<HTMLElement>(".lc-pdf-text");
        if (text) text.textContent = "";
        node?.removeAttribute("data-painted");
      }
    };

    const pageOut = async (n: number, keepText = true): Promise<void> => {
      if (isDocCameraLive()) return;
      const slot = host.querySelector<HTMLElement>(`[data-pdf-page="${n}"]`);
      const canvas = slot?.querySelector("canvas");
      if (!canvas) return;
      const sheet = await captureCanvasPng(canvas, () => isDocCameraLive());
      if (disposedRef.current) return;
      if (sheet) dropSessionText(sessionRef.current.put(n, sheet));
      // Finger went down during toBlob — keep the GPU canvas. Zeroing it
      // here is the white flash + the hitch they feel starting from rest.
      if (isDocCameraLive()) return;
      canvas.width = 0;
      canvas.height = 0;
      slot?.removeAttribute("data-painted");
      if (!keepText) {
        const text = slot?.querySelector<HTMLElement>(".lc-pdf-text");
        if (text) text.textContent = "";
      }
    };

    const paintOne = async (
      n: number,
      opts?: { yieldToCamera?: boolean },
    ): Promise<void> => {
      const entry = pagesRef.current.find((page) => page.pageNumber === n);
      const slot = host.querySelector<HTMLElement>(`[data-pdf-page="${n}"]`);
      const canvas = slot?.querySelector("canvas");
      const textHost = slot?.querySelector<HTMLElement>(".lc-pdf-text");
      const ctx = canvas?.getContext("2d");
      if (!entry || !slot || !canvas || !ctx || !textHost) return;
      if (opts?.yieldToCamera && isDocCameraLive()) return;

      // Same scale for focus and neighbours — a 1× prefetch upgraded on
      // intersect would re-enter the JBIG2 decoder. 2× is DPR, not a mipmap.
      const scale = PDF_RENDER_SCALE;
      let paint: { cancel: () => void; promise: Promise<void> } | null = null;
      let done = false;
      const stopLive =
        opts?.yieldToCamera === true
          ? subscribeDocCameraLive((live) => {
              if (!live) return;
              try {
                paint?.cancel();
              } catch {
                /* already finished */
              }
            })
          : null;
      paintedRef.current.set(n, {
        scale,
        release: () => {
          try {
            paint?.cancel();
          } catch {
            /* a render that already finished is nothing to cancel */
          }
          canvas.width = 0;
          canvas.height = 0;
        },
      });

      try {
        const paged = sessionRef.current.get(n);
        if (paged) {
          if (opts?.yieldToCamera && isDocCameraLive()) return;
          const ok = await restoreCanvasPng(canvas, paged);
          if (disposedRef.current) return;
          if (opts?.yieldToCamera && isDocCameraLive()) return;
          if (ok && textHost.childNodes.length > 0) {
            slot.setAttribute("data-painted", "");
            done = true;
            return;
          }
          if (ok) {
            const page = await doc.getPage(n);
            if (disposedRef.current) return;
            const content = await page.getTextContent();
            if (disposedRef.current) return;
            textHost.textContent = "";
            const layer = new TextLayer({
              textContentSource: content,
              container: textHost,
              viewport: page.getViewport({ scale: entry.fit }),
            });
            await layer.render();
            if (disposedRef.current) return;
            alignTextLayerToGlyphs(slot, layer.textDivs, content.items, entry.fit);
            slot.setAttribute("data-painted", "");
            done = true;
            return;
          }
        }

        const page = await doc.getPage(n);
        if (disposedRef.current) return;
        const viewport = page.getViewport({ scale: entry.fit * scale });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        paint = page.render({ canvas, canvasContext: ctx, viewport });
        await paint.promise;
        if (disposedRef.current) return;
        if (opts?.yieldToCamera && isDocCameraLive()) return;

        textHost.textContent = "";
        if (scale < PDF_RENDER_SCALE) {
          slot.setAttribute("data-painted", "");
          done = true;
          return;
        }
        const content = await page.getTextContent();
        if (disposedRef.current) return;
        const layer = new TextLayer({
          textContentSource: content,
          container: textHost,
          viewport: page.getViewport({ scale: entry.fit }),
        });
        await layer.render();
        if (disposedRef.current) return;
        alignTextLayerToGlyphs(slot, layer.textDivs, content.items, entry.fit);
        slot.setAttribute("data-painted", "");
        done = true;
      } catch (cause: unknown) {
        if (disposedRef.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!/cancel|abort|worker.*(destroy|terminat|not running)/i.test(message)) {
          onErrorRef.current?.(message);
        }
      } finally {
        stopLive?.();
        if (!done) {
          paintedRef.current.get(n)?.release();
          paintedRef.current.delete(n);
        }
      }
    };

    pumpRef.current = true;
    void (async () => {
      try {
        // Bounded: the window is a handful of pages, and each turn re-reads it,
        // so this ends as soon as what is wanted is what is painted.
        for (;;) {
          if (disposedRef.current) return;
          await yieldToInput();
          if (disposedRef.current) return;
          await waitWhileDocCameraLive();
          if (disposedRef.current) return;

          // Compress extras into the pagefile. Do not zero a live canvas
          // mid-flick — toBlob during coast is the hitch. Camera-live wait
          // above is what holds this until settle.
          for (const [n] of [...paintedRef.current]) {
            if (wantedRef.current.has(n)) continue;
            await waitWhileDocCameraLive();
            if (disposedRef.current) return;
            if (wantedRef.current.has(n)) continue;
            await pageOut(n, true);
            paintedRef.current.delete(n);
            if (disposedRef.current) return;
          }

          const visible = visibleRef.current;
          const batch = paintOrder(wantedRef.current, visible)
            .filter((n) =>
              pageNeedsPaint(n, paintedRef.current, visible, sessionRef.current),
            )
            .slice(0, PAINT_INFLIGHT);
          if (batch.length > 0) {
            await Promise.all(
              batch.map((n) =>
                paintOne(n, { yieldToCamera: !visible.has(n) }),
              ),
            );
            continue;
          }

          // Path fill: pages between this settle and the last one, so
          // TOC → chapter → back does not re-decode JBIG2. Paint then
          // immediately page out — they must not sit as extra GPU canvases.
          while (
            pathFillRef.current.length > 0 &&
            (wantedRef.current.has(pathFillRef.current[0]!) ||
              sessionRef.current.has(pathFillRef.current[0]!))
          ) {
            pathFillRef.current.shift();
          }
          const next = pathFillRef.current.shift();
          if (next == null) return;
          if (sessionRef.current.size() >= PDF_SESSION_CAP) {
            pathFillRef.current = [];
            return;
          }
          await waitWhileDocCameraLive();
          if (disposedRef.current) return;
          await paintOne(next, { yieldToCamera: true });
          if (disposedRef.current) return;
          await waitWhileDocCameraLive();
          if (disposedRef.current) return;
          if (!wantedRef.current.has(next)) {
            await pageOut(next, false);
            paintedRef.current.delete(next);
          }
        }
      } finally {
        pumpRef.current = false;
        /*
         * A window change that landed between "nothing left to paint" and here
         * saw the pump still running and did nothing. Re-check once the flag is
         * down, so that page is not left blank until the reader scrolls again.
         */
        if (!disposedRef.current) {
          const pendingHot = [...wantedRef.current].some((n) =>
            pageNeedsPaint(
              n,
              paintedRef.current,
              visibleRef.current,
              sessionRef.current,
            ),
          );
          const pendingPath = pathFillRef.current.some(
            (n) => !wantedRef.current.has(n) && !sessionRef.current.has(n),
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
      {pages.map((page) => (
        <div
          key={page.pageNumber}
          className="lc-pdf-page"
          data-pdf-page={page.pageNumber}
          /*
            Each page is its own offset space — see `docAnchors`. On a textbook
            that is the difference between resolving a mark on page 900 by
            walking one page and walking nine hundred, and it is what lets a
            footnote say which page it is on when the coach is told about it.
          */
          data-doc-scope={`p${page.pageNumber}`}
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
          */}
          <div className="lc-pdf-text textLayer" />
        </div>
      ))}
      {pages.length === 0 && <p className="lc-pdf-loading">Opening…</p>}
    </div>
  );
}

function waitWhileDocCameraLive(): Promise<void> {
  if (!isDocCameraLive()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = subscribeDocCameraLive((live) => {
      if (live) return;
      unsub();
      resolve();
    });
    if (!isDocCameraLive()) {
      unsub();
      resolve();
    }
  });
}

/**
 * Every live canvas uses the same scale. 2× is the panel's typical DPR, not
 * a pinch-zoom mipmap. A 1× neighbour upgraded on intersect re-enters JBIG2.
 */
export function pdfPagePaintScale(
  _page?: number,
  _visible?: Iterable<number>,
  hires = PDF_RENDER_SCALE,
): number {
  return hires;
}

function pageNeedsPaint(
  n: number,
  painted: Map<number, { scale: number }>,
  visible: Iterable<number>,
  session?: { has(page: number): boolean },
): boolean {
  const have = painted.get(n);
  if (!have) return true;
  // Session already holds decoded pixels. Inflating that PNG again is a
  // blit; `page.render` at a higher scale is the bitstream walk we skip.
  if (session?.has(n)) return false;
  return pdfPagePaintScale(n, visible) > have.scale;
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
): number[] {
  const wanted = new Set<number>();
  for (const n of visible) {
    for (let d = -radius; d <= radius; d += 1) {
      const near = n + d;
      if (near >= 1 && near <= lastPage) wanted.add(near);
    }
  }
  // Nothing visible yet — the observer's first callback has not run, and a book
  // must not open on a blank rectangle while it is scheduled.
  if (wanted.size === 0) {
    for (let n = 1; n <= Math.min(lastPage, 1 + radius); n += 1) wanted.add(n);
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
): number {
  if (pages.length === 0) return 0;
  return (
    pages.reduce((total, page) => total + page.height, 0) + gap * (pages.length - 1)
  );
}
