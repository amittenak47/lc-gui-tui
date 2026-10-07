import type { FootnoteRequestDto } from "../api/client";
import { abortTransaction, transactionOn } from "./idb";

const NAME = "whiteboard.footnotes";
const ROWS = "requests", META = "meta";
export const LEGACY_FOOTNOTE_QUEUE = "whiteboard.footnoteRequests.v1";
export const LEGACY_FOOTNOTE_AWAITING = "whiteboard.footnoteAwaiting.v1";
export interface FootnoteOutboxRow { id: string; docId: string; order?: number; request?: FootnoteRequestDto }

function legacy(key: string, originals: [string, string | null][]): unknown[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(key);
  originals.push([key, raw]);
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("The old GrokBot queue could not be read. Its data was retained.");
  return value;
}

async function withOutbox<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("GrokBot requests need device storage. The request has not been sent.")); return; }
    const request = indexedDB.open(NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ROWS, { keyPath: "id" });
      request.result.createObjectStore(META);
    };
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error("Another window is holding the GrokBot queue open. Close it and retry.")); };
  });
  db.onversionchange = () => db.close();
  try {
    const originals: [string, string | null][] = [];
    // Import both legacy lists and the marker in one transaction. Never clear
    // the originals before commit; the marker prevents replay after an ack.
    await transactionOn<void>(db, [ROWS, META], "readwrite", (tx, done) => {
      const meta = tx.objectStore(META), flag = meta.get("legacy-imported");
      flag.onsuccess = () => {
        try {
          if (!flag.result) {
            const rows = new Map<string, FootnoteOutboxRow>();
            for (const value of legacy(LEGACY_FOOTNOTE_AWAITING, originals)) {
              const row = value as Partial<FootnoteOutboxRow>;
              if (typeof row?.id !== "string" || !row.id || typeof row.docId !== "string") throw new Error("The old GrokBot queue has an unreadable entry. Its data was retained.");
              rows.set(row.id, { id: row.id, docId: row.docId });
            }
            for (const value of legacy(LEGACY_FOOTNOTE_QUEUE, originals)) {
              const row = value as FootnoteRequestDto;
              if (typeof row?.id !== "string" || !row.id || typeof row.doc_id !== "string") throw new Error("The old GrokBot queue has an unreadable entry. Its data was retained.");
              rows.set(row.id, { id: row.id, docId: row.doc_id, request: row });
            }
            let order = 0;
            for (const row of rows.values()) tx.objectStore(ROWS).put({ ...row, order: ++order });
            meta.put(order, "next-order");
            meta.put(true, "legacy-imported");
          }
          done(undefined);
        } catch (cause) { abortTransaction(tx, cause); }
      };
    });
    // Do not erase a legacy writer's changes made during the import.
    for (const [key, raw] of originals) {
      try { if (localStorage.getItem(key) === raw) localStorage.removeItem(key); }
      catch { /* marker makes retained originals safe */ }
    }
    return await work(db);
  } finally { db.close(); }
}

export function readFootnoteOutbox(): Promise<FootnoteOutboxRow[]> {
  return withOutbox(db => transactionOn(db, [ROWS], "readonly", (tx, done) => {
    const request = tx.objectStore(ROWS).getAll(); request.onsuccess = () => done(request.result.sort((a: FootnoteOutboxRow, b: FootnoteOutboxRow) => (a.order ?? 0) - (b.order ?? 0)));
  }));
}

export function storeFootnoteRequest(request: FootnoteRequestDto): Promise<void> {
  return withOutbox(db => transactionOn(db, [ROWS, META], "readwrite", (tx, done) => {
    const store = tx.objectStore(ROWS), existing = store.get(request.id);
    existing.onsuccess = () => {
      const meta = tx.objectStore(META), counter = meta.get("next-order");
      counter.onsuccess = () => {
        try {
          const order = existing.result?.order ?? (counter.result ?? 0) + 1;
          store.put({ id: request.id, docId: request.doc_id, order, request });
          meta.put(Math.max(counter.result ?? 0, order), "next-order");
          done(undefined);
        } catch (cause) { abortTransaction(tx, cause); }
      };
    };
  }));
}

export function markFootnoteRequestSent(id: string): Promise<void> {
  return withOutbox(db => transactionOn(db, [ROWS], "readwrite", (tx, done) => {
    const store = tx.objectStore(ROWS), get = store.get(id);
    get.onsuccess = () => {
      try {
        if (get.result) store.put({ id, docId: get.result.docId, order: get.result.order });
        done(undefined);
      } catch (cause) { abortTransaction(tx, cause); }
    };
  }));
}

export function forgetFootnoteRequest(id: string): Promise<void> {
  return withOutbox(db => transactionOn(db, [ROWS], "readwrite", (tx, done) => { tx.objectStore(ROWS).delete(id); done(undefined); }));
}
