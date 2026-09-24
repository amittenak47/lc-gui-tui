import { annotateFrameWidthFromElements } from "../templates/annotate";
import { layoutPdfPages, pdfStackFrames, PAGE_GAP, PDF_DOC_PAD_TOP, type PdfPageNatural } from "../modes/PdfDocument";

/** A frozen replica owns its layout, independently of the open reader's camera. */
export function conflictDocumentWidth(body: unknown, fallback?: number): number | undefined {
  const board = (body as { board?: { elements?: unknown } } | null)?.board;
  return Array.isArray(board?.elements)
    ? annotateFrameWidthFromElements(board.elements) ?? fallback
    : fallback;
}

/** Rebuild at the authored width: scaling preview Y also scales fixed page gaps incorrectly. */
export function conflictPdfFrames(pages: readonly PdfPageNatural[], width: number) {
  return pdfStackFrames(layoutPdfPages(pages, width), false, PAGE_GAP, PDF_DOC_PAD_TOP);
}
