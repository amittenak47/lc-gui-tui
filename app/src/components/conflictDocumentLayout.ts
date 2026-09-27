import { annotateFrameWidthFromElements } from "../templates/annotate";
import { layoutPdfPages, pdfStackFrames, PAGE_GAP, PDF_DOC_PAD_TOP, type PdfPageNatural } from "../modes/PdfDocument";

/** A frozen replica owns its layout, independently of the open reader's camera. */
export function conflictDocumentWidth(body: unknown, fallback?: number): number | undefined {
  const board = (body as { board?: { elements?: unknown } } | null)?.board;
  return Array.isArray(board?.elements)
    ? annotateFrameWidthFromElements(board.elements) ?? fallback
    : fallback;
}

/**
 * Rebuild at the authored width: scaling preview Y also scales fixed page gaps incorrectly.
 * `spread` lays each sheet out as two stacked halves, the way a device reading
 * split sheets placed its ink.
 */
export function conflictPdfFrames(pages: readonly PdfPageNatural[], width: number, spread = false) {
  return pdfStackFrames(layoutPdfPages(pages, width, spread), spread, PAGE_GAP, PDF_DOC_PAD_TOP);
}

/**
 * The layout a copy's PDF ink was written in, when the copy says.
 *
 * Boards stamp `pdfSpread` when they save a PDF; older copies do not, and the
 * caller falls back to what this device reads the file as.
 */
export function inkSpreadOf(body: unknown): boolean | undefined {
  const appState = (body as { board?: { appState?: { pdfSpread?: unknown } } } | null)?.board?.appState;
  return typeof appState?.pdfSpread === "boolean" ? appState.pdfSpread : undefined;
}
