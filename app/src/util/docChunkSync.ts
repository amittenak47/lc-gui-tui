/**
 * Push and pull document chunks through the hub.
 *
 * Each device has its own `docs.db`. Vectors computed on one have to reach
 * the other, keyed by (hash, page, ordinal) and guarded by a text hash so a
 * pdf.js shift cannot glue the wrong vector to the wrong words. No hub means
 * one database — there is nothing to sync.
 */

import type { LcClient } from "../api/client";
import { LcApiError } from "../api/client";
import { loadPadHub } from "./padHub";

export async function syncDocChunks(client: LcClient, hash: string): Promise<void> {
  const trimmed = hash.trim();
  if (!trimmed) return;
  if (!loadPadHub()) return;
  let remote;
  try {
    remote = await client.getDocChunks(trimmed);
  } catch (cause) {
    if (cause instanceof LcApiError && cause.status === 404) return;
    throw cause;
  }
  try {
    if (remote.chunks.length > 0) {
      const ack = await client.mergeDocChunksLocal(remote);
      if (ack.reason) return;
    }
  } catch (cause) {
    if (cause instanceof LcApiError && cause.status === 409) return;
    throw cause;
  }
  const local = await client.getDocChunksLocal(trimmed);
  if (local.chunks.length === 0) return;
  await client.putDocChunks(trimmed, local);
}
