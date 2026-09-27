/**
 * Every page's MediaBox, remembered per file.
 *
 * Laying a PDF out needs the size of every page, and pdf.js only answers that
 * one `getPage` round trip at a time through its worker — 432 of them for a
 * long book, in batches, each batch re-laying the whole stack. That was paid
 * on every open, including the relaunch that restores the tab you were
 * reading, and the open gate waits on it.
 *
 * The sizes are a fact about the bytes, and the key is their hash, so they can
 * never go stale. Stored run-length encoded (a book is mostly one page size)
 * under a short most-recent list so the store cannot grow without bound.
 */

import { setStorageItem } from "../util/storageQuota";

export interface PdfPageSize {
  pageNumber: number;
  width: number;
  height: number;
}

const PREFIX = "whiteboard.pdfSizes.v1:";
const INDEX_KEY = "whiteboard.pdfSizes.v1";
/** Books remembered. Each entry is a few dozen bytes for a typical file. */
export const PDF_SIZE_CACHE_DOCS = 40;

type Run = [count: number, width: number, height: number];

export function encodePageSizes(sizes: readonly PdfPageSize[]): Run[] {
  const runs: Run[] = [];
  for (const size of sizes) {
    const last = runs[runs.length - 1];
    if (last && last[1] === size.width && last[2] === size.height) last[0] += 1;
    else runs.push([1, size.width, size.height]);
  }
  return runs;
}

export function decodePageSizes(runs: unknown): PdfPageSize[] | null {
  if (!Array.isArray(runs)) return null;
  const out: PdfPageSize[] = [];
  for (const run of runs) {
    if (!Array.isArray(run) || run.length !== 3) return null;
    const [count, width, height] = run as unknown[];
    if (
      typeof count !== "number" || !Number.isInteger(count) || count < 1 ||
      typeof width !== "number" || !(width > 0) ||
      typeof height !== "number" || !(height > 0)
    ) {
      return null;
    }
    for (let i = 0; i < count; i += 1) out.push({ pageNumber: out.length + 1, width, height });
  }
  return out.length > 0 ? out : null;
}

function readIndex(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** The sizes for this file, when every page was measured before. */
export function loadPdfPageSizes(hash: string | null | undefined, numPages: number): PdfPageSize[] | null {
  if (!hash) return null;
  try {
    const raw = localStorage.getItem(PREFIX + hash);
    if (!raw) return null;
    const sizes = decodePageSizes(JSON.parse(raw));
    return sizes && sizes.length === numPages ? sizes : null;
  } catch {
    return null;
  }
}

export function savePdfPageSizes(hash: string | null | undefined, sizes: readonly PdfPageSize[]): void {
  if (!hash || sizes.length === 0) return;
  try {
    setStorageItem(PREFIX + hash, JSON.stringify(encodePageSizes(sizes)));
    const index = [hash, ...readIndex().filter((item) => item !== hash)];
    for (const gone of index.slice(PDF_SIZE_CACHE_DOCS)) localStorage.removeItem(PREFIX + gone);
    setStorageItem(INDEX_KEY, JSON.stringify(index.slice(0, PDF_SIZE_CACHE_DOCS)));
  } catch {
    /* quota — the next open measures again */
  }
}
