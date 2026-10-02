/**
 * A PDF's extras held back while it opens.
 *
 * Opening a book paints the page in view, then draws the reader's ink on it.
 * Between the two the paint pump went on to everything else the page had made
 * possible — its text layer, the pages either side, the slow fill of the rest
 * — and the ink, which the open waits for, waited behind all of it: the page
 * sat a second without its writing. While held, the pump paints only the pages
 * in view; the rest follows the moment the open lets go.
 *
 * Counted per document (its film scope), and let go by itself after a few
 * seconds whatever happens to the open, so nothing stays held by a failure.
 */

import { wakePdfPaintPump } from "./pdfFilm";

const HOLD_MAX_MS = 3000;
const holds = new Map<string, number>();

/** Hold this document's extras; call the result to let go. */
export function holdPdfExtras(scope: string, maxMs = HOLD_MAX_MS): () => void {
  holds.set(scope, (holds.get(scope) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    const left = (holds.get(scope) ?? 1) - 1;
    if (left > 0) holds.set(scope, left);
    else holds.delete(scope);
    wakePdfPaintPump(scope);
  };
  const timer = setTimeout(release, maxMs);
  return release;
}

export function pdfExtrasHeld(scope: string): boolean {
  return (holds.get(scope) ?? 0) > 0;
}
