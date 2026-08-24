/**
 * The viewer's open PDF, lent to the indexer so a second getDocument does not
 * fight the same worker during extract.
 */

type PdfJsDocument = Awaited<
  ReturnType<typeof import("pdfjs-dist").getDocument>["promise"]
>;

const lent = new Map<string, PdfJsDocument>();

export function lendPdfDocument(hash: string, doc: PdfJsDocument): void {
  if (!hash) return;
  lent.set(hash, doc);
}

export function borrowPdfDocument(hash: string): PdfJsDocument | null {
  if (!hash) return null;
  return lent.get(hash) ?? null;
}

export function dropPdfDocument(hash: string, doc: PdfJsDocument): void {
  if (!hash) return;
  if (lent.get(hash) === doc) lent.delete(hash);
}
