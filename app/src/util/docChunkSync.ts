/**
 * Push and pull document chunks through the hub.
 *
 * Each device has its own `docs.db`. Vectors computed on one have to reach
 * the other, keyed by (hash, page, ordinal) and guarded by a text hash so a
 * pdf.js shift cannot glue the wrong vector to the wrong words. No hub means
 * one database — there is nothing to sync.
 *
 * A ping first asks for counts. Documents whose `(chunks_total, chunks_embedded,
 * embed_model)` already agree move no vectors. A text-hash mismatch refuses
 * without deleting the receiver; this module records the reason so the chip
 * can offer a re-index.
 */

import type { DocChunkBundle, DocChunkDigest, LcClient } from "../api/client";
import { LcApiError } from "../api/client";
import { loadPadHub } from "./padHub";

export const CHUNK_TEXT_MISMATCH = "chunk text hash mismatch";

export const CHUNK_MISMATCH_MESSAGE =
  "This device's index disagreed with the hub — the chunks are not the same text. Re-index this document.";

const mismatchByHash = new Map<string, string>();
const mismatchListeners = new Set<() => void>();

export function docChunkMismatchReason(hash: string): string | null {
  const trimmed = hash.trim();
  if (!trimmed) return null;
  return mismatchByHash.get(trimmed) ?? null;
}

export function subscribeDocChunkMismatch(listener: () => void): () => void {
  mismatchListeners.add(listener);
  return () => {
    mismatchListeners.delete(listener);
  };
}

export function clearDocChunkMismatch(hash: string): void {
  const trimmed = hash.trim();
  if (!trimmed || !mismatchByHash.delete(trimmed)) return;
  for (const listener of mismatchListeners) listener();
}

function noteMismatch(hash: string): void {
  mismatchByHash.set(hash, CHUNK_MISMATCH_MESSAGE);
  for (const listener of mismatchListeners) listener();
}

function digestEquals(a?: DocChunkDigest, b?: DocChunkDigest): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.embed_model === b.embed_model &&
    a.chunks_total === b.chunks_total &&
    a.chunks_embedded === b.chunks_embedded
  );
}

function isMismatch(reason?: string): boolean {
  return Boolean(reason && reason.startsWith(CHUNK_TEXT_MISMATCH));
}

function posKey(page: number, ordinal: number): string {
  return `${page}:${ordinal}`;
}

function remoteEmbedded(remote: DocChunkBundle | null): Set<string> {
  const out = new Set<string>();
  if (!remote) return out;
  for (const chunk of remote.chunks) {
    if (chunk.embedded === 1) out.add(posKey(chunk.page, chunk.ordinal));
  }
  return out;
}

export async function syncDocChunks(
  client: LcClient,
  hashes: string | string[],
): Promise<void> {
  if (!loadPadHub()) return;
  const unique = [
    ...new Set(
      (Array.isArray(hashes) ? hashes : [hashes]).map((hash) => hash.trim()).filter(Boolean),
    ),
  ];
  if (unique.length === 0) return;

  const [remoteDigests, localDigests] = await Promise.all([
    client.listDocChunkDigests(),
    client.listDocChunkDigestsLocal(),
  ]);
  const remoteBy = new Map(remoteDigests.map((row) => [row.hash, row]));
  const localBy = new Map(localDigests.map((row) => [row.hash, row]));

  for (const hash of unique) {
    try {
      await syncOne(client, hash, localBy.get(hash), remoteBy.get(hash));
    } catch {
      /* one book must not abort the rest of the library */
    }
  }
}

async function syncOne(
  client: LcClient,
  hash: string,
  local?: DocChunkDigest,
  remote?: DocChunkDigest,
): Promise<void> {
  if (!local || local.chunks_total === 0) return;
  if (
    local.embed_model &&
    remote?.embed_model &&
    local.embed_model !== remote.embed_model
  ) {
    return;
  }
  if (digestEquals(local, remote)) {
    clearDocChunkMismatch(hash);
    return;
  }

  let remoteBundle: DocChunkBundle | null = null;
  if (remote && remote.chunks_total > 0) {
    try {
      remoteBundle = await client.getDocChunks(hash);
    } catch (cause) {
      if (!(cause instanceof LcApiError && cause.status === 404)) throw cause;
      remoteBundle = { hash, embed_model: "", chunks: [] };
    }
    if (remoteBundle.chunks.length > 0) {
      const ack = await client.mergeDocChunksLocal(remoteBundle);
      if (isMismatch(ack.reason)) {
        noteMismatch(hash);
        return;
      }
    }
  }

  const localBundle = await client.getDocChunksLocal(hash);
  const already = remoteEmbedded(remoteBundle);
  const delta = localBundle.chunks.filter(
    (chunk) => chunk.embedded === 1 && !already.has(posKey(chunk.page, chunk.ordinal)),
  );
  if (delta.length === 0) {
    clearDocChunkMismatch(hash);
    return;
  }
  const ack = await client.putDocChunks(hash, {
    hash: localBundle.hash,
    embed_model: localBundle.embed_model,
    chunks: delta,
  });
  if (isMismatch(ack.reason)) {
    noteMismatch(hash);
    return;
  }
  clearDocChunkMismatch(hash);
}
