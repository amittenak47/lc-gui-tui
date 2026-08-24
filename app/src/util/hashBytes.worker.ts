/**
 * Off-thread FNV-1a for textbook-sized bodies.
 *
 * The digest must match {@link hashBytesDigest} exactly — it is the IndexedDB
 * and index key. Do not transfer the caller's buffer; the open still needs it.
 */

import { hashBytesDigest } from "./hashBytesDigest";

export type HashBytesRequest = { id: number; bytes: ArrayBuffer };
export type HashBytesResponse = { id: number; hash: string };

self.onmessage = (event: MessageEvent<HashBytesRequest>) => {
  const { id, bytes } = event.data;
  const hash = hashBytesDigest(bytes);
  (self as unknown as Worker).postMessage({ id, hash } satisfies HashBytesResponse);
};
