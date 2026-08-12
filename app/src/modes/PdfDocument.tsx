/**
 * A PDF as the page under the ink.
 *
 * Same contract as `MdInkDocument`: no scrollbar of its own, no pointer of its
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
 * about 18 GB. Time is not the problem here; memory is. So a window of pages
 * around the viewport holds bitmaps and text layers, and everything else is
 * released back to a blank div of the right size.
 *
 * The text layer goes with the bitmap, which means a mark on a page that is
 * not in the window cannot resolve — and that is fine, because the marker
 * layer keeps a window of its own on the same pages and re-places whatever
 * arrives (see `DocSelectionLayer`).
 */

import { type CSSProperties, useEffect, useRef, useState } from "react";

/**
 * Supersampling of the page bitmap relative to its scene size.
 *
 * The board commonly shows a document page near zoom 1 and lets the reader zoom
 * in on a figure; at 1× the text would go soft exactly when they do that. Two is
 * the usual device-pixel-ratio ceiling on the tablets this runs on, so it is
 * the point past which more pixels stop being visible.
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
 * Pages kept painted either side of the one being read.
 *
 * The previous page, the current one, the next: enough that a page turn in
 * either direction is already drawn, and bounded so the resident set is a
 * handful of bitmaps whatever the book's length. At ~12 MB a page that is the
 * difference between 60 MB and, for a 1500-page textbook, 18 GB.
 */
const PAGE_WINDOW_RADIUS = 1;

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
  /** Scroll mode: the text layer answers the pointer so quotes can be picked. */
  selectable?: boolean;
  onError?: (message: string) => void;
}

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
async function loadPdfJs() {
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
  frameWidth,
  onMeasure,
  selectable = false,
  onError,
}: PdfDocumentProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  /** The open document, shared by the layout pass and the paint pass. */
  const docRef = useRef<Awaited<
    ReturnType<typeof import("pdfjs-dist").getDocument>["promise"]
  > | null>(null);
  const taskRef = useRef<ReturnType<typeof import("pdfjs-dist").getDocument> | null>(null);
  const textLayerRef = useRef<typeof import("pdfjs-dist").TextLayer | null>(null);
  /** Pages holding a bitmap right now, and how to give it back. */
  const paintedRef = useRef<Map<number, { release: () => void }>>(new Map());
  /** Pages the viewport can currently see. */
  const visibleRef = useRef<Set<number>>(new Set());
  /** Pages the window wants painted — the visible ones, plus their neighbours. */
  const wantedRef = useRef<Set<number>>(new Set());
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
    disposedRef.current = false;
    // pdf.js detaches the buffer it is handed, and React may run this effect
    // twice in development — a copy keeps the prop reusable either way.
    const data = bytes.slice(0);
    setPages([]);
    paintedRef.current.clear();
    wantedRef.current = new Set();
    visibleRef.current = new Set();

    void (async () => {
      try {
        const pdfjs = await loadPdfJs();
        // Teardown lives on the loading task, not the document — keep it.
        const task = pdfjs.getDocument({
          data,
          /*
           * Font metrics and character maps, served from the bundle.
           *
           * pdf.js fetches these by URL rather than importing them, so they are
           * copied out of the package at build time (see `pdfjsAssets` in
           * vite.config). Without the fonts a document that assumes the base-14
           * set renders with the wrong glyph widths; without the cmaps a CJK or
           * scanned document renders blank.
           */
          standardFontDataUrl: new URL("standard_fonts/", document.baseURI).href,
          cMapUrl: new URL("cmaps/", document.baseURI).href,
          cMapPacked: true,
        });
        taskRef.current = task;
        const doc = await task.promise;
        if (cancelled) return;
        docRef.current = doc;
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
        }
        if (cancelled) return;
        setPages(laid);
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
  }, [bytes, frameWidth]);

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

    /** Visible pages, grown by a page either side. */
    const rebuild = () => {
      const wanted = new Set(windowedPages(visibleRef.current, last));
      const before = wantedRef.current;
      const same =
        before.size === wanted.size && [...wanted].every((n) => before.has(n));
      if (same) return;
      wantedRef.current = wanted;
      setWindowTick((tick) => tick + 1);
    };

    rebuild();

    if (typeof IntersectionObserver !== "function") {
      // No observer: paint everything, as this component always used to. Worse
      // on a textbook, but a working reader beats a blank one.
      wantedRef.current = new Set(pages.map((page) => page.pageNumber));
      setWindowTick((tick) => tick + 1);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.pdfPage);
          if (!Number.isFinite(n)) continue;
          if (entry.isIntersecting) visibleRef.current.add(n);
          else visibleRef.current.delete(n);
        }
        rebuild();
      },
      { rootMargin: PAGE_VISIBLE_MARGIN },
    );
    for (const slot of slots) observer.observe(slot);
    return () => observer.disconnect();
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

    const byNumber = new Map(pages.map((page) => [page.pageNumber, page]));

    const paintOne = async (n: number): Promise<void> => {
      const entry = byNumber.get(n);
      const slot = host.querySelector<HTMLElement>(`[data-pdf-page="${n}"]`);
      const canvas = slot?.querySelector("canvas");
      const textHost = slot?.querySelector<HTMLElement>(".lc-pdf-text");
      const ctx = canvas?.getContext("2d");
      if (!entry || !slot || !canvas || !ctx || !textHost) return;

      /*
       * Claimed before the first await, so a later pump turn does not start
       * this page again underneath the one already working on it — and given
       * up again in `finally` unless it finished, because a claim left behind
       * by an abandoned paint is a page that stays blank for ever.
       */
      let paint: { cancel: () => void; promise: Promise<void> } | null = null;
      let done = false;
      paintedRef.current.set(n, {
        release: () => {
          try {
            paint?.cancel();
          } catch {
            /* a render that already finished is nothing to cancel */
          }
          // Zero the backing store: clearing pixels leaves the allocation, and
          // the allocation is the whole reason for the window.
          canvas.width = 0;
          canvas.height = 0;
          textHost.textContent = "";
          slot.removeAttribute("data-painted");
        },
      });

      try {
        const page = await doc.getPage(n);
        if (disposedRef.current) return;
        const viewport = page.getViewport({ scale: entry.fit * PDF_RENDER_SCALE });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        paint = page.render({ canvas, canvasContext: ctx, viewport });
        await paint.promise;
        if (disposedRef.current) return;

        textHost.textContent = "";
        const layer = new TextLayer({
          textContentSource: await page.getTextContent(),
          container: textHost,
          // The laid-out scale, not the supersampled one: these spans sit over
          // the picture in scene units, not in bitmap pixels.
          viewport: page.getViewport({ scale: entry.fit }),
        });
        await layer.render();
        if (disposedRef.current) return;
        slot.setAttribute("data-painted", "");
        done = true;
      } catch (cause: unknown) {
        if (disposedRef.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        // A cancelled render is the window moving on, not a failure.
        if (!/cancel/i.test(message)) onErrorRef.current?.(message);
      } finally {
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

          // Release first, so the memory is back before the next bitmap asks.
          for (const [n, entry] of [...paintedRef.current]) {
            if (wantedRef.current.has(n)) continue;
            entry.release();
            paintedRef.current.delete(n);
          }

          const next = paintOrder(wantedRef.current, visibleRef.current).find(
            (n) => !paintedRef.current.has(n),
          );
          if (next == null) return;
          await paintOne(next);
        }
      } finally {
        pumpRef.current = false;
        /*
         * A window change that landed between "nothing left to paint" and here
         * saw the pump still running and did nothing. Re-check once the flag is
         * down, so that page is not left blank until the reader scrolls again.
         */
        if (!disposedRef.current) {
          const pending = [...wantedRef.current].some((n) => !paintedRef.current.has(n));
          if (pending) setWindowTick((tick) => tick + 1);
        }
      }
    })();
  }, [pages, windowTick]);

  // Height is reported from the laid-out stack rather than summed from the page
  // sizes: the gaps, and any rounding the browser does, belong in the number the
  // page frame grows to, or ink at the bottom of the last page gets clipped.
  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
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
    wanted.add(1);
    if (lastPage >= 2) wanted.add(2);
  }
  return [...wanted].sort((a, b) => a - b);
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
