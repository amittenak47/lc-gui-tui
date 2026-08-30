/**
 * Quote-time PDF text fill: one-shot, keyed by film scope.
 *
 * The paint pump fills spans when the camera is idle. A hold-marquee can
 * confirm before that lands, so the selection sheet asks here, then re-reads
 * the DOM. PdfDocument registers the filler for its scope.
 */

const fills = new Map<string, (page: number) => Promise<boolean>>();

export function registerPdfQuoteTextFill(
  scope: string,
  fill: (page: number) => Promise<boolean>,
): () => void {
  fills.set(scope, fill);
  return () => {
    if (fills.get(scope) === fill) fills.delete(scope);
  };
}

export async function fillPdfQuoteText(scope: string, page: number): Promise<boolean> {
  if (!scope || !(page >= 1)) return false;
  const fill = fills.get(scope);
  if (!fill) return false;
  return fill(page);
}
