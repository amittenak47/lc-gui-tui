/**
 * Persisted scene tiles. Separate database from `whiteboard.docs` so a version
 * bump here cannot deadlock the document connection (see pdfThumbStore).
 *
 * Tiles are camera-independent bitmaps. A full-quit reopen of an unchanged
 * page is a hydrate + blit, not another SDF walk of every stroke.
 */

import { inkClipFingerprint, inkOpsFingerprint } from "./inkOpsFingerprint";
import type { InkOp, SceneBounds } from "./rasterInk";

export const INK_TILE_DB = "whiteboard.inkTiles";
export const INK_TILE_DB_VERSION = 1;
export const INK_TILE_STORE = "tiles";
/** Soft cap so a dense textbook cannot fill the origin. */
export const INK_TILE_STORE_CAP = 512;

export type StoredInkTile = {
  level: number;
  tx: number;
  ty: number;
  blob: Blob;
  width: number;
  height: number;
};

type StoredInkTileRow = StoredInkTile & {
  sig: string;
  usedAt: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function resetInkTileStoreForTests(): void {
  dbPromise = null;
}

export function inkTilePersistKey(
  ops: readonly InkOp[],
  clip: SceneBounds | null,
): string {
  // Older workers could persist pixels missing newly appended ink under the
  // new history's key. Rebuild those disposable bitmaps from the saved ops.
  return `v2:${inkOpsFingerprint(ops, inkClipFingerprint(clip))}`;
}

function tileKey(sig: string, level: number, tx: number, ty: number): string {
  return `${sig}\x1f${level}\x1f${tx}\x1f${ty}`;
}

function openTileDb(): Promise<IDBDatabase> {
  const existing = dbPromise;
  if (existing) return existing;
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("this device has no IndexedDB"));
      return;
    }
    const request = indexedDB.open(INK_TILE_DB, INK_TILE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(INK_TILE_STORE)) {
        db.createObjectStore(INK_TILE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("could not open the ink tile store"));
    request.onblocked = () =>
      reject(new Error("another tab is holding an older ink tile store"));
  }).catch((cause: unknown) => {
    dbPromise = null;
    throw cause;
  });
  dbPromise = opened;
  return opened;
}

export async function loadPersistedInkTiles(sig: string): Promise<StoredInkTile[]> {
  if (!sig || typeof indexedDB === "undefined") return [];
  try {
    const db = await openTileDb();
    return await new Promise<StoredInkTile[]>((resolve, reject) => {
      const tx = db.transaction(INK_TILE_STORE, "readonly");
      const store = tx.objectStore(INK_TILE_STORE);
      const range = IDBKeyRange.bound(`${sig}\x1f`, `${sig}\x1f\uffff`);
      const request = store.getAll(range);
      const rows: StoredInkTile[] = [];
      request.onsuccess = () => {
        const all = (request.result ?? []) as StoredInkTileRow[];
        for (const row of all) {
          if (row?.blob && row.sig === sig) {
            rows.push({
              level: row.level,
              tx: row.tx,
              ty: row.ty,
              blob: row.blob,
              width: row.width,
              height: row.height,
            });
          }
        }
      };
      tx.oncomplete = () => resolve(rows);
      tx.onabort = () =>
        reject(tx.error ?? new Error("ink tile read aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("ink tile read failed"));
    });
  } catch {
    return [];
  }
}

let writeCount = 0;

export async function persistInkTile(
  sig: string,
  tile: StoredInkTile,
): Promise<void> {
  if (!sig || typeof indexedDB === "undefined") return;
  try {
    const db = await openTileDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(INK_TILE_STORE, "readwrite");
      const store = tx.objectStore(INK_TILE_STORE);
      const row: StoredInkTileRow = {
        ...tile,
        sig,
        usedAt: Date.now(),
      };
      store.put(row, tileKey(sig, tile.level, tile.tx, tile.ty));
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? new Error("ink tile write aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("ink tile write failed"));
    });
    writeCount += 1;
    if (writeCount % 32 === 0) void evictInkTiles();
  } catch {
    /* private mode / quota */
  }
}

async function evictInkTiles(): Promise<void> {
  try {
    const db = await openTileDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(INK_TILE_STORE, "readwrite");
      const store = tx.objectStore(INK_TILE_STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const extra = (countReq.result ?? 0) - INK_TILE_STORE_CAP;
        if (extra <= 0) return;
        const ranked: Array<{ key: IDBValidKey; usedAt: number }> = [];
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const row = cursor.value as StoredInkTileRow;
            ranked.push({ key: cursor.key, usedAt: row.usedAt ?? 0 });
            cursor.continue();
            return;
          }
          ranked.sort((a, b) => a.usedAt - b.usedAt);
          for (let i = 0; i < extra && i < ranked.length; i += 1) {
            store.delete(ranked[i]!.key);
          }
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("ink tile evict aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("ink tile evict failed"));
    });
  } catch {
    /* ignore */
  }
}

export async function blobFromTileSource(
  source: CanvasImageSource,
  width: number,
  height: number,
): Promise<Blob | null> {
  try {
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0);
      return await canvas.convertToBlob({ type: "image/png" });
    }
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("tile blob failed"));
      }, "image/png");
    });
  } catch {
    return null;
  }
}
