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
import { AnnotateDocument } from "../modes/AnnotateDocument";
import { DocSelectionLayer } from "../modes/DocSelectionLayer";
import { PdfDocument } from "../modes/PdfDocument";
import { borrowPdfDocument } from "../modes/pdfOpenDocs";
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
