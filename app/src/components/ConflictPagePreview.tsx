/**
 * One page of the open PDF, for the conflict split.
 *
 * Both panes share this document. We do not mount a second viewer: reuse the
 * filmstrip JPEG if one exists, else paint the lent pdf.js document at a
 * small scale. Missing hash (whiteboard, markdown) is just the page number.
 */

import { useEffect, useState } from "react";

import { borrowPdfDocument } from "../modes/pdfOpenDocs";
import {
  capturePdfThumbIfNew,
  hydratePdfThumbs,
  peekPdfThumb,
  pdfThumbViewportScale,
  rememberPdfThumb,
  subscribePdfThumbs,
} from "../modes/pdfFilm";
import { loadStoredPdfThumbs } from "../modes/pdfThumbStore";

const PREVIEW_CSS_WIDTH = 280;

export function ConflictPagePreview({
  hash,
  page,
}: {
  hash?: string;
  page: number;
}) {
  const [thumbTick, setThumbTick] = useState(0);
  useEffect(() => subscribePdfThumbs(() => setThumbTick((n) => n + 1)), []);

  useEffect(() => {
    if (!hash) return;
    let gone = false;
    void loadStoredPdfThumbs(hash).then((stored) => {
      if (gone || stored.size === 0) return;
      hydratePdfThumbs(hash, stored);
    });
    return () => {
      gone = true;
    };
  }, [hash]);

  const thumb = peekPdfThumb(hash, page);
  useEffect(() => {
    if (!hash || !(page >= 1) || thumb) return;
    capturePdfThumbIfNew(hash, page);
    if (peekPdfThumb(hash, page)) return;
    const doc = borrowPdfDocument(hash);
    if (!doc || page > doc.numPages) return;
    let gone = false;
    void (async () => {
      try {
        const pdfPage = await doc.getPage(page);
        if (gone) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const scale = Math.max(0.35, pdfThumbViewportScale(natural.width, PREVIEW_CSS_WIDTH, 1));
        const viewport = pdfPage.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (gone) return;
        rememberPdfThumb(hash, page, canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        /* caption stays */
      }
    })();
    return () => {
      gone = true;
    };
  }, [hash, page, thumb, thumbTick]);

  return (
    <div className="lc-hub-conflict-preview" data-page={String(page)}>
      {thumb ? (
        <img alt={`Page ${page}`} src={thumb} />
      ) : (
        <p className="lc-muted">Page {page}</p>
      )}
    </div>
  );
}
