/**
 * Where the heavy half of a library entry lives.
 *
 * An entry is a small description — id, name, hash, when it was touched — and a
 * large payload: the board, the ink, the images, and for markdown and code a
 * copy of the whole source file. Both halves used to sit in one `localStorage`
 * key per library, and that arrangement had three separate ways of failing:
 *
 *   - **It could not fit.** `CODE_SOURCE_MAX_CHARS` is 1.5M and the library
 *     holds 30 entries, so the per-file guard alone permitted 90 MB of UTF-16
 *     against a ~5 MB quota. Ink, images and coach attachments were on top of
 *     that.
 *   - **It rewrote everything to change anything.** One entry's autosave
 *     re-serialised all thirty, every three seconds, on the main thread. That
 *     is the cost `CHANGELOG.md` records as the stroke stopping mid-letter.
 *   - **Listing the library parsed all of it.** Rendering thirty file names
 *     meant `JSON.parse` over every board in the store.
 *
 * So the halves are split. Meta stays in `localStorage`, where it is tiny and
 * synchronous — which is what keeps the library dialog able to render without
 * awaiting anything. Content goes to IndexedDB: one record per entry, written
 * on its own, structured-cloned rather than stringified.
 *
 * **Falling back is not optional.** IndexedDB is absent or refuses to open in
 * Safari private browsing, in WebViews with storage switched off, and while
 * another tab holds an older version of the database. When that happens content
 * goes back into `localStorage` under a per-entry key, and every later save
 * retries IndexedDB — promoting whatever spilled as soon as it opens. The
 * writer never finds out either happened.
 */

import { run, withStore, STORE_CONTENT } from "./idb";
import { setStorageItem } from "./storageQuota";

/** Per-entry spill key. Per-entry, not per-library, so a fallback save is still small. */
function spillKey(id: string): string {
  return `whiteboard.content.v1.${id}`;
}

const SPILL_PREFIX = "whiteboard.content.v1.";

/**
 * Which backend the last write used.
 *
 * Not a cache of "is IndexedDB available" — it is re-asked on every save,
 * because the answer changes: the tab blocking an upgrade closes, private
 * browsing ends, the device frees space. `false` here only means the previous
 * attempt spilled, which is what tells the next one to try promoting.
 */
let spilled = false;

/** Ids sitting in `localStorage` waiting to be moved across. */
function spilledIds(): string[] {
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(SPILL_PREFIX)) ids.push(key.slice(SPILL_PREFIX.length));
    }
  } catch {
    /* a store that will not even enumerate has nothing to promote */
  }
  return ids;
}

/**
 * Move anything that spilled back into IndexedDB.
 *
 * Best-effort and silent. Called after a successful write, when we have just
 * proven the database opens; a failure here leaves the spill exactly where it
 * was, which is the state it was already surviving in.
 */
async function promoteSpilled(): Promise<void> {
  for (const id of spilledIds()) {
    try {
      const raw = localStorage.getItem(spillKey(id));
      if (raw == null) continue;
      await run(STORE_CONTENT, "readwrite", (store) => store.put(JSON.parse(raw), id));
      localStorage.removeItem(spillKey(id));
    } catch {
      // Stop at the first failure rather than grinding through the rest: they
      // will all fail the same way, and the next save tries again.
      return;
    }
  }
  spilled = spilledIds().length > 0;
}

/**
 * Store one entry's content.
 *
 * Throws only when *both* backends refuse — at which point the caller has a
 * genuine out-of-space condition to report, and `StorageFullError` from the
 * spill is the more useful of the two failures to hand on.
 */
export async function putContent(id: string, content: unknown): Promise<void> {
  try {
    await run(STORE_CONTENT, "readwrite", (store) => store.put(content, id));
    // The database is open and writing, so anything stranded can come across.
    if (spilled) await promoteSpilled();
    return;
  } catch {
    // Fall through to the spill. Deliberately not reported: a device where
    // IndexedDB is unavailable still works, and saying so on every save would
    // be a banner nobody can act on.
  }
  setStorageItem(spillKey(id), JSON.stringify(content));
  spilled = true;
}

/** Read one entry's content back, from wherever it ended up. */
export async function getContent<T>(id: string): Promise<T | null> {
  try {
    const value = await run<T | undefined>(STORE_CONTENT, "readonly", (store) =>
      store.get(id),
    );
    if (value !== undefined) return value;
  } catch {
    /* fall through — a spilled entry is still readable */
  }
  try {
    const raw = localStorage.getItem(spillKey(id));
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

/** Remove an entry's content from both backends — either may hold it. */
export async function deleteContent(id: string): Promise<void> {
  try {
    await run(STORE_CONTENT, "readwrite", (store) => store.delete(id));
  } catch {
    /* nothing there, or nothing open — the spill removal below still matters */
  }
  try {
    localStorage.removeItem(spillKey(id));
  } catch {
    /* best-effort */
  }
}

/**
 * Drop every content key that starts with `prefix`.
 *
 * Used to sweep footnote-owned boards (`fnwb:{docId}:`) when an annotation
 * set is deleted. Walks IndexedDB by cursor and the spill keys by prefix so
 * an orphan cannot survive on only one backend.
 */
export async function deleteContentByPrefix(prefix: string): Promise<void> {
  if (!prefix) return;
  try {
    await withStore(STORE_CONTENT, "readwrite", (store) => {
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
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(`${SPILL_PREFIX}${prefix}`)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* best-effort */
  }
}

/**
 * Read several entries at once, for a migration or a bulk export.
 *
 * Returns a map rather than an array so a missing entry is visibly missing
 * instead of shifting everything after it.
 */
export async function getManyContent<T>(ids: readonly string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  for (const id of ids) {
    const value = await getContent<T>(id);
    if (value != null) out.set(id, value);
  }
  return out;
}
