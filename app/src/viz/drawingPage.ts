import { pdfPageFromDocScope } from "../util/docMarquee";
import { pageFromScope } from "../util/conflictPage";

export interface DrawingPageMark {
  id: string;
  anchor?: { scope?: string };
}

/** Prefer a stored page, then a footnote scope, then the page the ask was on. */
export function pageForNewDrawing(
  footnoteIds: readonly string[] | undefined,
  footnotes: readonly DrawingPageMark[],
  fallbackPage?: number | null,
): number | undefined {
  for (const id of footnoteIds ?? []) {
    const mark = footnotes.find((entry) => entry.id === id);
    const page = pageFromDrawingScope(mark?.anchor?.scope);
    if (page) return page;
  }
  if (fallbackPage != null && fallbackPage >= 1) return Math.floor(fallbackPage);
  return undefined;
}

export function pageFromDrawingScope(scope?: string | null): number | undefined {
  const fromNote = pageFromScope(scope);
  if (fromNote) return fromNote;
  const fromPdf = pdfPageFromDocScope(scope);
  return fromPdf ?? undefined;
}

export function resolveDrawingPage(
  storedPage: number | undefined,
  footnoteIds: readonly string[] | undefined,
  footnotes: readonly DrawingPageMark[],
): number | undefined {
  if (storedPage != null && storedPage >= 1) return Math.floor(storedPage);
  return pageForNewDrawing(footnoteIds, footnotes, null);
}

/**
 * Pin an unscoped drawing to the page that is in view when it first appears.
 * Later camera moves then have a page to hide against. `viewKnown` waits until
 * the film has published a real hole, so a default current of 1 is not bound.
 */
export function bindDrawingPage(
  resolved: number | undefined,
  alreadyBound: number | undefined,
  liveCurrent: number,
  paged: boolean,
  viewKnown = false,
): number | undefined {
  if (resolved != null && resolved >= 1) return Math.floor(resolved);
  if (alreadyBound != null && alreadyBound >= 1) return Math.floor(alreadyBound);
  if (paged && viewKnown && liveCurrent >= 1) return Math.floor(liveCurrent);
  return undefined;
}

/**
 * Paged documents: the overlay follows the camera. A drawing with no page is
 * off-screen until `bindDrawingPage` gives it one. Markdown (not paged) stays
 * with the document.
 */
export function drawingIsOnScreen(
  page: number | undefined,
  currentPage: number,
  intersectingPages: readonly number[],
  paged = false,
): boolean {
  if (!paged) return true;
  if (page == null || page < 1) return false;
  if (intersectingPages.includes(page)) return true;
  if (intersectingPages.length > 0) return false;
  return currentPage >= 1 && page === currentPage;
}
