/**
 * One side of the conflict split: the same document harness as the reader,
 * scrolled in this pane — not the 48px filmstrip JPEG.
 *
 * Marks and packed ink overlay the stack, filtered by the current picks. The
 * change list sits on top of this in the parent.
 */

import { useEffect, useRef, useState } from "react";

import type { InkPageDto } from "../api/client";
import { b64ToBytes } from "../api/nativeHttp";
import { decodeInkOps, unpackEncodedInk } from "../canvas/inkCodec";
import { paintInkAtScale, type InkOp } from "../canvas/rasterInk";
import { setDocCameraLive, setDocPointerHeld } from "../canvas/docSelectionGesture";
import { AnnotateDocument } from "../modes/AnnotateDocument";
import { DocSelectionLayer } from "../modes/DocSelectionLayer";
import { PdfDocument } from "../modes/PdfDocument";
import { publishPdfFilmCurrent, publishPdfViewPages } from "../modes/pdfFilm";
import { borrowPdfDocument } from "../modes/pdfOpenDocs";
import { pdfRestPages, pdfVisibleFromSpans } from "../modes/pdfPaintWindow";
import { cameraPulseSettleMs } from "../util/cameraBusy";
import { bytesFromMaybeGzip } from "../util/gzip";
import type { DocFootnote } from "../util/docFootnotes";

const EMPTY_PDF_BYTES = new ArrayBuffer(0);

async function opsFromGz(gz: string): Promise<InkOp[] | null> {
  try {
    const encoded = unpackEncodedInk(await bytesFromMaybeGzip(b64ToBytes(gz)));
    if (!encoded) return null;
    return decodeInkOps(encoded);
  } catch {
    return null;
  }
}

export function ConflictPagePreview({
  hash,
  page,
  notes,
  inkPages,
  showInk = false,
  bytes,
  filmScope,
  sourceText,
  sceneWidth,
}: {
  hash?: string;
  page: number;
  notes?: readonly DocFootnote[];
  inkPages?: readonly InkPageDto[];
  showInk?: boolean;
  bytes?: ArrayBuffer;
  filmScope?: string;
  sourceText?: string;
  /** Board scene width the ink was drawn in, so overlay maps onto this pane. */
  sceneWidth?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const inkRef = useRef<HTMLCanvasElement | null>(null);
  const [cssWidth, setCssWidth] = useState(0);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const [stackH, setStackH] = useState(0);

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const apply = () => {
      const width = Math.round(node.clientWidth);
      if (width > 0) setCssWidth(width);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = hostRef.current;
    if (!root || page < 1) return;
    const node = root.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`);
    if (!node) return;
    const top = node.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTo({ top });
  }, [page, stackH]);

  const borrowed = hash ? borrowPdfDocument(hash) : null;
  const usePdf =
    Boolean(filmScope) &&
    Boolean(hash) &&
    cssWidth > 0 &&
    (Boolean(bytes && bytes.byteLength > 0) || Boolean(borrowed));
  const useMarkdown = !usePdf && Boolean(sourceText);

  const keptNotes = notes ?? [];
  const inkForPage = (inkPages ?? []).filter((row) => row.page_id >= 1);

  /*
   * Scrolling this pane has to reach the same paint path the reader uses.
   *
   * The pane looked sharp at rest and went to placeholders the moment you
   * flicked it, which reads as a thumbnail strip but is not one — it is the
   * paint window. `PdfDocument` decides what to blit and at what scale from
   * `publishPdfViewPages` plus `isDocCameraLive`, and both of those are
   * published by `Board` from its camera. A standalone pane has no camera, so
   * nobody ever published them: the observer only moved C, the rest set stayed
   * empty, and every slot outside it sat at preview scale.
   *
   * So the pane publishes the same two facts from its own boxes. This is not a
   * second paint loop — nothing here decodes or draws. It says where the
   * viewport is; `blitOuterFromLru` and the decode pump do the rest, exactly
   * as they do for the board.
   */
  useEffect(() => {
    const root = scrollRoot;
    if (!root || !filmScope || !usePdf) return;
    let frame = 0;
    let settle = 0;

    const sample = () => {
      frame = 0;
      const view = root.getBoundingClientRect();
      const spans: Array<{ page: number; top: number; bottom: number }> = [];
      let lastPage = 1;
      for (const el of root.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
        const n = Number(el.dataset.pdfPage);
        if (!Number.isFinite(n) || n < 1) continue;
        lastPage = Math.max(lastPage, n);
        const box = el.getBoundingClientRect();
        spans.push({ page: n, top: box.top, bottom: box.bottom });
      }
      if (spans.length === 0) return;
      const { intersecting, current } = pdfVisibleFromSpans(spans, view.top, view.bottom);
      if (current < 1) return;
      publishPdfFilmCurrent(filmScope, current);
      publishPdfViewPages(
        filmScope,
        intersecting,
        pdfRestPages(current, lastPage, intersecting),
      );
    };

    /*
     * Live while the finger moves, settled a beat after it stops.
     *
     * The same pulse the board runs: while live the pump only does
     * preview-scale hole pages, and rest-2 fills on the settle. Without it the
     * pane would try to decode at full scale mid-flick and stutter.
     */
    const pulse = () => {
      setDocCameraLive(true);
      window.clearTimeout(settle);
      settle = window.setTimeout(() => setDocCameraLive(false), cameraPulseSettleMs());
    };
    const onMove = () => {
      pulse();
      if (frame) return;
      frame = requestAnimationFrame(sample);
    };
    // Freeze on touch-down, before pan has armed — the pump must not fight the
    // finger during the gap the board also covers.
    const onDown = () => setDocPointerHeld(true);
    const onUp = () => setDocPointerHeld(false);

    root.addEventListener("scroll", onMove, { passive: true });
    root.addEventListener("wheel", onMove, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: true });
    root.addEventListener("pointerdown", onDown);
    // On `window`: a finger that leaves the pane still ended the gesture.
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    // Publish once for where the pane already is, rather than waiting for a
    // scroll that may never come — the landing page is the one being read.
    sample();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      root.removeEventListener("scroll", onMove);
      root.removeEventListener("wheel", onMove);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDocPointerHeld(false);
      setDocCameraLive(false);
    };
    // `stackH` re-runs this once the stack has a height, so the first sample
    // measures real slots rather than an empty host.
  }, [scrollRoot, filmScope, usePdf, stackH]);

  useEffect(() => {
    const canvas = inkRef.current;
    if (!canvas || !filmScope) return;
    const width = Math.max(1, Math.round(cssWidth));
    const height = Math.max(1, Math.round(stackH));
    canvas.width = width;
    canvas.height = height;
    if (!showInk || inkForPage.length === 0) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      return;
    }
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const paint = ctx;
    const scale = sceneWidth && sceneWidth > 0 ? width / sceneWidth : 1;
    let gone = false;
    void Promise.all(
      inkForPage.map(async (row) => {
        if (!row.gz) return;
        const ops = await opsFromGz(row.gz);
        if (gone || !ops || ops.length === 0) return;
        paintInkAtScale(paint, ops, { x: 0, y: 0 }, scale);
      }),
    );
    return () => {
      gone = true;
    };
  }, [showInk, inkPages, filmScope, cssWidth, stackH, sceneWidth]);

  return (
    <div
      ref={(node) => {
        hostRef.current = node;
        setScrollRoot((current) => (current === node ? current : node));
      }}
      className={usePdf || useMarkdown ? "lc-hub-conflict-preview is-harness" : "lc-hub-conflict-preview"}
      data-page={String(page)}
    >
      {usePdf && filmScope ? (
        <div className="lc-hub-conflict-doc">
          <DocSelectionLayer enabled={false} footnotes={keptNotes}>
            <PdfDocument
              filmScope={filmScope}
              bytes={bytes && bytes.byteLength > 0 ? bytes : EMPTY_PDF_BYTES}
              docHash={hash}
              frameWidth={cssWidth}
              initialPage={page}
              standalone
              scrollRoot={scrollRoot}
              idleThumbs={false}
              selectable={false}
              spread={false}
              onMeasure={setStackH}
            />
          </DocSelectionLayer>
          {showInk ? (
            <canvas ref={inkRef} className="lc-hub-conflict-ink-layer" aria-hidden />
          ) : null}
        </div>
      ) : useMarkdown && sourceText ? (
        <div className="lc-hub-conflict-doc">
          <DocSelectionLayer enabled={false} footnotes={keptNotes}>
            <AnnotateDocument source={sourceText} selectable={false} />
          </DocSelectionLayer>
        </div>
      ) : (
        <p className="lc-muted">Page {page}</p>
      )}
    </div>
  );
}
