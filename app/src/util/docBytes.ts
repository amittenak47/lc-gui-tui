/**
 * The bytes of a binary document, kept where bytes can actually live.
 *
 * Markdown annotation sets carry a copy of their source in the library JSON,
 * which works because a note is a few kilobytes of text. A textbook PDF is
 * tens of megabytes, and `localStorage` is a synchronous string store with a
 * quota around five — putting a PDF through it would be a base64 round trip on
 * the main thread that fails a third of the way in. IndexedDB takes a `Blob`
 * as-is, off the main thread, with no encoding.
 *
 * Keyed by content hash, exactly like the annotations that go with it. That is
 * what makes reopening a file from the library work without ever having known
 * where on disk it came from, and it is also why two copies of the same
 * textbook in two folders cost one entry rather than two.
 *
 * The connection and the transaction wrapper moved to `idb` when board content
 * needed the same database — they must share one open handle and one version
 * number, or two opens at different versions deadlock against each other.
 */

import { run, STORE_BYTES } from "./idb";

const STORE = STORE_BYTES;

export async function putDocBytes(hash: string, bytes: ArrayBuffer): Promise<void> {
  // Stored as a Blob rather than an ArrayBuffer: structured clone of a Blob is
  // a reference, so a 40 MB textbook is not copied through memory on save.
  await run(STORE, "readwrite", (store) => store.put(new Blob([bytes]), hash));
}

export async function getDocBytes(hash: string): Promise<ArrayBuffer | null> {
  const value = await run<Blob | ArrayBuffer | undefined>(STORE, "readonly", (store) =>
    store.get(hash),
  );
  if (!value) return null;
  return value instanceof Blob ? await value.arrayBuffer() : value;
}

export async function deleteDocBytes(hash: string): Promise<void> {
  await run(STORE, "readwrite", (store) => store.delete(hash));
}

export async function hasDocBytes(hash: string): Promise<boolean> {
  const key = await run<IDBValidKey | undefined>(STORE, "readonly", (store) =>
    store.getKey(hash),
  );
  return key != null;
}

/**
 * Content hash of a binary document.
 *
 * FNV-1a over the bytes, for the same reason `hashMarkdown` uses it over the
 * text: this answers "is this the file I annotated last time", and the
 * alternative to a cheap wrong answer is SHA-256 over 40 MB on the main thread
 * every time a book is opened. Length is mixed into the label so two files that
 * collide in 32 bits still have to be the same size to be confused.
 */
export function hashBytes(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let hash = 0x811c9dc5;
  for (let i = 0; i < view.length; i += 1) {
    hash ^= view[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `bin${hash.toString(36)}-${view.length.toString(36)}`;
}
