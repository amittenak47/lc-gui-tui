/**
 * Rendered markdown, kept between launches.
 *
 * `marked` + KaTeX + DOMPurify over a long note is two seconds of a tablet's
 * main thread, paid again on every launch for a file that has not changed.
 * The result is a pure function of the source and of those three libraries,
 * so it is stored here under a digest of the source and their versions, and
 * a later open of the same text reads it back instead of rendering again.
 *
 * Safe to reuse: what is stored is DOMPurify's own output from an earlier
 * render. Anything able to write this database could already run script in
 * the app.
 *
 * Its own database, like the PDF thumbnails: a cache lives on its own version
 * clock, is never walked by library housekeeping, and can be dropped whole.
 */

import DOMPurify from "dompurify";
import katex from "katex";

export const MD_HTML_DB = "whiteboard.renderCache";
export const MD_HTML_DB_VERSION = 3;
export const MD_HTML_STORE = "markdown_html";
/** Per-block heights from a full layout: see {@link MarkdownLayoutRecord}. */
export const MD_LAYOUT_STORE = "markdown_layout";
/** When each stored render was last opened, and how big it is. Rows here are tiny. */
export const MD_INDEX_STORE = "markdown_index";

/** Bump when `renderMarkdown`'s options or extensions change what it emits. */
const RENDER_SCHEMA = 1;
/**
 * Renders kept, least recently opened dropped first. A long note with math
 * renders to around a million characters, so the size cap is what usually
 * binds; the count keeps many small notes from piling up.
 */
export const MD_HTML_KEEP = 16;
export const MD_HTML_MAX_CHARS = 24_000_000;
/** Layout records are a few KB: plenty, so a note at two widths keeps both. */
export const MD_LAYOUT_KEEP = 48;
/** Below this the render is quicker than the read. */
export const MD_HTML_CACHE_MIN_CHARS = 20_000;

interface CachedRender {
  html: string;
  storedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Tests that stub `indexedDB` must drop the cached open. */
export function resetMarkdownHtmlCacheForTests(): void {
  dbPromise = null;
}

/**
 * Two 32-bit lanes over the whole text, plus its length: a collision would
 * need two notes of the same length that agree on both lanes.
 */
export function sourceDigest(source: string): string {
  let h1 = 0xdeadbeef ^ source.length;
  let h2 = 0x41c6ce57 ^ source.length;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${source.length.toString(36)}-${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`;
}

export function markdownCacheKey(source: string): string {
  return `${RENDER_SCHEMA}:${katex.version}:${DOMPurify.version}\x1f${sourceDigest(source)}`;
}

function openCacheDb(): Promise<IDBDatabase> {
  const existing = dbPromise;
  if (existing) return existing;
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("this device has no IndexedDB"));
      return;
    }
    const request = indexedDB.open(MD_HTML_DB, MD_HTML_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MD_HTML_STORE)) db.createObjectStore(MD_HTML_STORE);
      if (!db.objectStoreNames.contains(MD_LAYOUT_STORE)) db.createObjectStore(MD_LAYOUT_STORE);
      if (!db.objectStoreNames.contains(MD_INDEX_STORE)) db.createObjectStore(MD_INDEX_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open the render cache"));
    request.onblocked = () => reject(new Error("another tab is holding an older render cache"));
  }).catch((cause: unknown) => {
    dbPromise = null;
    throw cause;
  });
  dbPromise = opened;
  return opened;
}

/** The stored render of exactly this text, or null. Never throws. */
export async function loadMarkdownHtml(source: string): Promise<string | null> {
  if (source.length < MD_HTML_CACHE_MIN_CHARS || typeof indexedDB === "undefined") return null;
  try {
    const db = await openCacheDb();
    return await new Promise<string | null>((resolve) => {
      const tx = db.transaction(MD_HTML_STORE, "readonly");
      const request = tx.objectStore(MD_HTML_STORE).get(markdownCacheKey(source));
      request.onsuccess = () => {
        const row = request.result as CachedRender | undefined;
        const html = row && typeof row.html === "string" && row.html ? row.html : null;
        resolve(html);
        if (html) void touchMarkdownHtml(markdownCacheKey(source), html.length);
      };
      request.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } catch {
    return null;
  }
}

interface RenderUse {
  usedAt: number;
  chars: number;
}

/** A hit: this render was opened now. A tiny write, not the render itself. */
async function touchMarkdownHtml(key: string, chars: number): Promise<void> {
  try {
    const db = await openCacheDb();
    const tx = db.transaction(MD_INDEX_STORE, "readwrite");
    tx.objectStore(MD_INDEX_STORE).put({ usedAt: Date.now(), chars } satisfies RenderUse, key);
  } catch {
    /* an unrecorded open only makes this render look older */
  }
}

/**
 * Which renders to drop: the least recently opened first, until what is left
 * is within {@link MD_HTML_KEEP} renders and {@link MD_HTML_MAX_CHARS}.
 * Renders with no index row predate it and go first.
 */
export function rendersToDrop(
  keys: readonly IDBValidKey[],
  uses: ReadonlyMap<IDBValidKey, RenderUse>,
): IDBValidKey[] {
  const newestFirst = [...keys].sort((a, b) => (uses.get(b)?.usedAt ?? 0) - (uses.get(a)?.usedAt ?? 0));
  const drop: IDBValidKey[] = [];
  let kept = 0;
  let chars = 0;
  for (const key of newestFirst) {
    const size = uses.get(key)?.chars ?? MD_HTML_MAX_CHARS;
    if (kept < MD_HTML_KEEP && chars + size <= MD_HTML_MAX_CHARS) {
      kept++;
      chars += size;
    } else {
      drop.push(key);
    }
  }
  return drop;
}

/** Keep this render for the next open, then trim the cache to its limits. Never throws. */
export async function storeMarkdownHtml(source: string, html: string): Promise<void> {
  if (source.length < MD_HTML_CACHE_MIN_CHARS || !html || typeof indexedDB === "undefined") return;
  if (html.length > MD_HTML_MAX_CHARS) return;
  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction([MD_HTML_STORE, MD_INDEX_STORE], "readwrite");
      const renders = tx.objectStore(MD_HTML_STORE);
      const index = tx.objectStore(MD_INDEX_STORE);
      const key = markdownCacheKey(source);
      renders.put({ html, storedAt: Date.now() } satisfies CachedRender, key);
      index.put({ usedAt: Date.now(), chars: html.length } satisfies RenderUse, key);
      // Keys and index rows only: the renders themselves are megabytes.
      const keys = renders.getAllKeys();
      const indexKeys = index.getAllKeys();
      const indexRows = index.getAll();
      indexRows.onsuccess = () => {
        const uses = new Map<IDBValidKey, RenderUse>();
        (indexKeys.result as IDBValidKey[]).forEach((k, i) => uses.set(k, (indexRows.result as RenderUse[])[i]!));
        for (const old of rendersToDrop(keys.result as IDBValidKey[], uses)) {
          renders.delete(old);
          index.delete(old);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* private mode / quota: the next open renders, as it always did */
  }
}

/**
 * How a rendered note laid out, block by block, the last time it was laid out
 * in full at this width and type size.
 *
 * `heights[i]` is the top-level block's height in CSS px, or 0 where the block
 * may not be skipped. A relaunch hands these to `contain-intrinsic-size` so
 * the blocks off screen are never laid out at all, and every block below them
 * still sits exactly where it did.
 */
export interface MarkdownLayoutRecord {
  heights: number[];
  storedAt: number;
}

/** What the layout depends on besides the text: the column and the type. */
export function markdownLayoutKey(source: string, shape: string): string {
  return `${markdownCacheKey(source)}\x1f${shape}`;
}

async function layoutRequest<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openCacheDb();
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(MD_LAYOUT_STORE, mode);
      const request = run(tx.objectStore(MD_LAYOUT_STORE));
      let value: T | null = null;
      if (request) request.onsuccess = () => { value = (request.result as T) ?? null; };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => resolve(null);
      tx.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function loadMarkdownLayout(key: string): Promise<MarkdownLayoutRecord | null> {
  const row = await layoutRequest<MarkdownLayoutRecord | undefined>("readonly", (store) => store.get(key));
  return row && Array.isArray(row.heights) ? row : null;
}

export async function storeMarkdownLayout(key: string, heights: number[]): Promise<void> {
  await layoutRequest("readwrite", (store) => {
    store.put({ heights, storedAt: Date.now() } satisfies MarkdownLayoutRecord, key);
    const keys = store.getAllKeys();
    const rows = store.getAll();
    rows.onsuccess = () => {
      const all = (keys.result as IDBValidKey[]).map((k, i) => ({
        key: k,
        at: (rows.result as MarkdownLayoutRecord[])[i]?.storedAt ?? 0,
      }));
      all.sort((a, b) => b.at - a.at);
      for (const old of all.slice(MD_LAYOUT_KEEP)) store.delete(old.key);
    };
  });
}

/** A block came out a different size from its record: lay out in full next time. */
export async function dropMarkdownLayout(key: string): Promise<void> {
  await layoutRequest("readwrite", (store) => {
    store.delete(key);
  });
}
