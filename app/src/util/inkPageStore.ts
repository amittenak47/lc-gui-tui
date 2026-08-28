/**
 * Per-page encoded ink in IndexedDB — the dirty WAL and the optional gzip archive.
 *
 * Live autosave used to `encodeInkOps` the whole book into `content.board.inkC`.
 * A 1500-page dense textbook is tens of MB of typed arrays cloned on a 3s
 * timer. This store writes only the pages that changed, as structured-clone
 * `EncodedInk` (not JSON, not localStorage). Page 0 is the spanning shard.
 *
 * `content.board.inkC` stays readable for old entries and for snapshots; new
 * live saves prefer these keys and keep a manifest on the blob.
 */

import {
  unpackEncodedInk,
  type EncodedInk,
} from "../canvas/inkCodec";
import { bytesFromMaybeGzip } from "./gzip";
import { run, STORE_INK_PAGES, withStore } from "./idb";

const KEY_SEP = "\u001f";

export interface InkPageRecord {
  v: 1;
  docKey: string;
  pageId: number;
  /** Uncompressed WAL. Present while dirty, or on devices that never gzipped. */
  inkC?: EncodedInk;
  /** Worker-gzipped {@link packEncodedInk} bytes. */
  gz?: Uint8Array<ArrayBuffer>;
  dirty: boolean;
  updatedAt: number;
}

/**
 * Ink for one annotation set.
 *
 * Keyed by the sidecar's library id, not by the hash of the file it was drawn
 * over. Two annotation sets on one PDF are two ids and one hash; keying on the
 * hash meant they shared these rows, so the second set's strokes landed on top
 * of the first set's. The id is minted when the document opens, before anything
 * is saved, so ink written in the first few seconds still has somewhere of its
 * own to go. See `migrateAnnotateKeysToId` in `annotateStore` for the rows
 * written by the build that keyed these on the hash.
 */
export function annotateDocKey(sidecarId: string): string {
  return `md:${sidecarId}`;
}

export function whiteboardDocKey(id: string): string {
  return `wb:${id}`;
}

/** Session ink for a footnote-owned scratch board — not the PDF's `md:` pages. */
export function footnoteWhiteboardDocKey(docId: string, wbId: string): string {
  return `fnwb:${docId}:${wbId}`;
}

export function inkPageKey(docKey: string, pageId: number): string {
  return `${docKey}${KEY_SEP}${pageId}`;
}

export function inkPageKeyRange(docKey: string): IDBKeyRange {
  return IDBKeyRange.bound(`${docKey}${KEY_SEP}`, `${docKey}${KEY_SEP}\uffff`);
}

function isRecord(value: unknown): value is InkPageRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as InkPageRecord;
  return row.v === 1 && typeof row.docKey === "string" && typeof row.pageId === "number";
}

export async function encodedFromRecord(row: InkPageRecord): Promise<EncodedInk | null> {
  if (row.inkC) return row.inkC;
  if (!row.gz) return null;
  try {
    const raw = await bytesFromMaybeGzip(row.gz);
    return unpackEncodedInk(raw);
  } catch {
    return null;
  }
}

/**
 * Promote dirty WAL → gzip archive only if this is still the row we listed.
 *
 * A stroke that landed while the worker was compressing must keep its newer
 * `inkC`. Overwriting it with the gzip of the previous save would drop ink.
 */
export function shouldPromoteToArchive(
  existing: InkPageRecord | null | undefined,
  expectedUpdatedAt: number,
): boolean {
  if (!existing?.dirty || !existing.inkC) return false;
  return existing.updatedAt === expectedUpdatedAt;
}

export async function getInkPageRecord(
  docKey: string,
  pageId: number,
): Promise<InkPageRecord | null> {
  try {
    const row = await run<InkPageRecord | undefined>(
      STORE_INK_PAGES,
      "readonly",
      (store) => store.get(inkPageKey(docKey, pageId)),
    );
    return row && isRecord(row) ? row : null;
  } catch {
    return null;
  }
}

export async function putInkPages(
  docKey: string,
  pages: Map<number, EncodedInk> | Iterable<[number, EncodedInk]>,
  opts?: { dirty?: boolean; now?: number },
): Promise<void> {
  const dirty = opts?.dirty !== false;
  const now = opts?.now ?? Date.now();
  const entries = [...pages];
  if (entries.length === 0) return;
  await withStore(STORE_INK_PAGES, "readwrite", (store) => {
    for (const [pageId, inkC] of entries) {
      const row: InkPageRecord = {
        v: 1,
        docKey,
        pageId,
        inkC,
        dirty,
        updatedAt: now,
      };
      store.put(row, inkPageKey(docKey, pageId));
    }
  });
}

export async function putInkPageArchive(
  docKey: string,
  pageId: number,
  gz: Uint8Array<ArrayBuffer>,
  expectedUpdatedAt: number,
): Promise<boolean> {
  const existing = await getInkPageRecord(docKey, pageId);
  if (!shouldPromoteToArchive(existing, expectedUpdatedAt)) return false;
  const row: InkPageRecord = {
    v: 1,
    docKey,
    pageId,
    gz,
    dirty: false,
    updatedAt: Date.now(),
  };
  await run(STORE_INK_PAGES, "readwrite", (store) => store.put(row, inkPageKey(docKey, pageId)));
  return true;
}

export async function getInkPages(docKey: string): Promise<Map<number, EncodedInk>> {
  const rows = await getInkPageRecords(docKey);
  const out = new Map<number, EncodedInk>();
  for (const row of rows) {
    const encoded = await encodedFromRecord(row);
    if (encoded) out.set(row.pageId, encoded);
  }
  return out;
}

export async function getInkPageRecords(docKey: string): Promise<InkPageRecord[]> {
  const rows: InkPageRecord[] = [];
  try {
    await withStore(STORE_INK_PAGES, "readonly", (store) => {
      const request = store.openCursor(inkPageKeyRange(docKey));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (isRecord(cursor.value)) rows.push(cursor.value);
        cursor.continue();
      };
    });
  } catch {
    return [];
  }
  return rows;
}

export async function getInkPage(docKey: string, pageId: number): Promise<EncodedInk | null> {
  const row = await getInkPageRecord(docKey, pageId);
  if (!row) return null;
  return encodedFromRecord(row);
}

export async function deleteInkPages(docKey: string): Promise<void> {
  try {
    await withStore(STORE_INK_PAGES, "readwrite", (store) => {
      const request = store.openCursor(inkPageKeyRange(docKey));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
    });
  } catch {
    /* private browsing / missing store */
  }
}

/** Drop every ink shard whose docKey starts with `prefix` (e.g. `fnwb:{docId}:`). */
export async function deleteInkPagesByPrefix(prefix: string): Promise<void> {
  if (!prefix) return;
  try {
    await withStore(STORE_INK_PAGES, "readwrite", (store) => {
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
    });
  } catch {
    /* private browsing / missing store */
  }
}

/**
 * Move every page of ink from one doc key to another.
 *
 * Only used by the hash-to-id migration. Copy-then-delete rather than a cursor
 * `update`: the key is part of the record's identity here, and a half-finished
 * rename that left rows under both keys would restore ink twice.
 */
export async function renameInkPages(fromKey: string, toKey: string): Promise<number> {
  const rows = await getInkPageRecords(fromKey);
  if (rows.length === 0) return 0;
  try {
    await withStore(STORE_INK_PAGES, "readwrite", (store) => {
      for (const row of rows) {
        store.put({ ...row, docKey: toKey }, inkPageKey(toKey, row.pageId));
      }
    });
  } catch {
    // Nothing was moved, so leave the originals where they are and try again
    // on the next open rather than deleting ink we failed to copy.
    return 0;
  }
  await deleteInkPages(fromKey);
  return rows.length;
}

/** Leftover dirty rows from a crash — gzip drain (WAKE_UP). */
export async function listDirtyInkPages(): Promise<InkPageRecord[]> {
  const rows: InkPageRecord[] = [];
  try {
    await withStore(STORE_INK_PAGES, "readonly", (store) => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const value = cursor.value;
        if (isRecord(value) && value.dirty && value.inkC) rows.push(value);
        cursor.continue();
      };
    });
  } catch {
    return [];
  }
  return rows;
}
