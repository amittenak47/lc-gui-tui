/**
 * Settings → Storage → Duplicate strokes: find, and on request remove, exact
 * copies of strokes that older merges stored more than once.
 *
 * Tiles already draw each stroke once (`InkTileLayer`), so this is about
 * storage, sync size and memory, not what the page shows. Removal keeps the
 * first of each set of copies, keeps a page's layout tag, and marks the page
 * changed so the cleaned copy syncs; open documents are told to reload.
 */

import { decodeInkOps, encodeInkOps, packEncodedInk } from "../canvas/inkCodec";
import { countInkOpDuplicates, dedupeInkOps } from "../canvas/inkOpsDedupe";
import { STORE_INK_PAGES, withStore } from "./idb";
import { gzipBytes } from "./gzip";
import {
  encodedFromRecord,
  getInkPageRecords,
  inkPageKey,
  listInkDocKeys,
  type InkPageRecord,
} from "./inkPageStore";
import { PAD_HUB_WINDOW_EVENT, type PadHubWindowDetail } from "./padSync";

export interface InkDuplicateReport {
  /** Documents and notebooks with at least one copy. */
  books: number;
  pages: number;
  strokes: number;
  duplicates: number;
  duplicatePoints: number;
  removed: boolean;
}

function padOf(docKey: string): PadHubWindowDetail | null {
  if (docKey.startsWith("md:")) return { kind: "annotate", id: docKey.slice(3), op: "reload" };
  if (docKey.startsWith("wb:")) return { kind: "whiteboard", id: docKey.slice(3), op: "reload" };
  return null;
}

export async function auditInkDuplicates(opts: { remove: boolean }): Promise<InkDuplicateReport> {
  const report: InkDuplicateReport = { books: 0, pages: 0, strokes: 0, duplicates: 0, duplicatePoints: 0, removed: opts.remove };
  const docKeys = [...(await listInkDocKeys("md:")), ...(await listInkDocKeys("wb:"))];
  const touched = new Set<string>();
  for (const docKey of docKeys) {
    const rows = await getInkPageRecords(docKey, { strict: true });
    let bookHasCopies = false;
    for (const row of rows) {
      // A page another device sent that is not in this device's layout yet.
      if (row.layoutPending) continue;
      const encoded = await encodedFromRecord(row);
      if (!encoded) continue;
      const ops = decodeInkOps(encoded);
      report.strokes += ops.length;
      const copies = countInkOpDuplicates(ops);
      if (copies.ops === 0) continue;
      bookHasCopies = true;
      report.pages += 1;
      report.duplicates += copies.ops;
      report.duplicatePoints += copies.points;
      if (!opts.remove) continue;
      const kept = encodeInkOps(dedupeInkOps(ops));
      if (encoded.layout) kept.layout = encoded.layout;
      const next: InkPageRecord = {
        ...row,
        gz: await gzipBytes(packEncodedInk(kept)),
        inkC: undefined,
        sum: undefined,
        dirty: true,
        updatedAt: Date.now(),
      };
      await withStore(STORE_INK_PAGES, "readwrite", (store) => {
        const key = inkPageKey(docKey, row.pageId);
        const request = store.get(key);
        request.onsuccess = () => {
          // Written meanwhile (a pen stroke, a sync): leave it for the next run.
          if ((request.result as InkPageRecord | undefined)?.updatedAt === row.updatedAt) store.put(next, key);
        };
      });
      touched.add(docKey);
    }
    if (bookHasCopies) report.books += 1;
  }
  if (typeof window !== "undefined") {
    for (const docKey of touched) {
      const detail = padOf(docKey);
      if (detail) window.dispatchEvent(new CustomEvent(PAD_HUB_WINDOW_EVENT, { detail }));
    }
  }
  return report;
}
