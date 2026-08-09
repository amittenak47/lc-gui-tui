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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    // pdf.js detaches the buffer it is handed, and React may run this effect
    // twice in development — a copy keeps the prop reusable either way.
    const data = bytes.slice(0);

    const cleanups: Array<() => void> = [];

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
        cleanups.push(() => void task.destroy());
        const doc = await task.promise;
        if (cancelled) return;

        const laid: RenderedPage[] = [];
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
          if (cancelled) return;
          const page = await doc.getPage(pageNumber);
          const natural = page.getViewport({ scale: 1 });
          // Per page, not per document: a scanned plate among typeset pages is
          // a different size, and a book-wide factor would letterbox one or
          // crop the other.
          const fit = natural.width > 0 ? frameWidth / natural.width : 1;
          const viewport = page.getViewport({ scale: fit });
          laid.push({
            pageNumber,
            fit,
            width: Math.round(viewport.width),
            height: Math.round(viewport.height),
          });
        }
        if (cancelled) return;
        setPages(laid);

        // Second pass paints into the nodes the state above just created, so
        // the stack has its full height (and the frame has grown to it) before
        // any bitmap work starts.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (cancelled) return;

        const { TextLayer } = pdfjs;
        for (const entry of laid) {
          if (cancelled) return;
          const slot = host.querySelector<HTMLElement>(
            `[data-pdf-page="${entry.pageNumber}"]`,
          );
          if (!slot) continue;
          const page = await doc.getPage(entry.pageNumber);
          const viewport = page.getViewport({ scale: entry.fit * PDF_RENDER_SCALE });
          const canvas = slot.querySelector("canvas");
          const ctx = canvas?.getContext("2d");
          if (canvas && ctx) {
            canvas.width = Math.round(viewport.width);
            canvas.height = Math.round(viewport.height);
            const paint = page.render({ canvas, canvasContext: ctx, viewport });
            cleanups.push(() => paint.cancel());
            await paint.promise;
          }
          if (cancelled) return;
          const textHost = slot.querySelector<HTMLElement>(".lc-pdf-text");
          if (textHost) {
            textHost.textContent = "";
            const layer = new TextLayer({
              textContentSource: await page.getTextContent(),
              container: textHost,
              // The laid-out scale, not the supersampled one: these spans sit
              // over the picture in scene units, not in bitmap pixels.
              viewport: page.getViewport({ scale: entry.fit }),
            });
            await layer.render();
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
      for (const stop of cleanups.reverse()) {
        try {
          stop();
        } catch {
          /* a render already finished is nothing to cancel */
        }
      }
    };
  }, [bytes, frameWidth]);

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
          <div className="lc-pdf-text" />
        </div>
      ))}
      {pages.length === 0 && <p className="lc-pdf-loading">Opening…</p>}
    </div>
  );
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
