/**
 * The bytes a reader just picked, handed to the workspace about to open them.
 *
 * Picking a PDF used to cost several passes over the same file. The picker
 * hashed it (a worker copy), stored it (an IndexedDB copy), and opened a tab.
 * The workspace that mounted then read the whole thing *back* out of
 * IndexedDB, hashed it a second time, and stored it a second time — before
 * pdf.js took its own copy. A textbook briefly occupied several times its own
 * size, on the device least able to afford it.
 *
 * None of those repeats learn anything. The bytes have not changed, and
 * `putDocBytesVerified` has already proved the row is there — that check is
 * what the second write existed to guarantee, and it has already happened.
 *
 * So the picker leaves them here and the mounting workspace takes them. One
 * slot, because one file is picked at a time and a second pick means the first
 * hand-off is never coming: holding a spare textbook alive is exactly the cost
 * this exists to avoid. For the same reason it expires — a tab closed between
 * the pick and the mount must not pin a buffer for the rest of the session.
 */

/** Bytes are dropped if the workspace has not claimed them by now. */
const HANDOFF_TTL_MS = 60_000;

type Handoff = {
  tabId: string;
  hash: string;
  bytes: ArrayBuffer;
  at: number;
};

let pending: Handoff | null = null;

/** Leave the picked bytes for `tabId`. Replaces anything unclaimed. */
export function handOffPickedDoc(tabId: string, hash: string, bytes: ArrayBuffer): void {
  if (!tabId || !hash) return;
  pending = { tabId, hash, bytes, at: Date.now() };
}

/**
 * Take the bytes left for `tabId`, if they are still there.
 *
 * Returns null for anyone else, and for a hand-off that has gone stale. The
 * slot is cleared either way — this is a hand-off, not a cache, and the store
 * is the thing that remembers.
 */
export function takePickedDoc(
  tabId: string,
): { hash: string; bytes: ArrayBuffer } | null {
  const held = pending;
  if (!held) return null;
  if (held.tabId !== tabId) {
    if (Date.now() - held.at > HANDOFF_TTL_MS) pending = null;
    return null;
  }
  pending = null;
  if (Date.now() - held.at > HANDOFF_TTL_MS) return null;
  return { hash: held.hash, bytes: held.bytes };
}

/** Drop an unclaimed hand-off — the open was cancelled or failed. */
export function dropPickedDoc(tabId?: string): void {
  if (!pending) return;
  if (tabId && pending.tabId !== tabId) return;
  pending = null;
}
