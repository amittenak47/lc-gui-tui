/**
 * How a notebook's ink comes back.
 *
 * Live strokes live in shards (`wb:{id}`), not in the pad JSON. Autosave
 * writes empty `inkC` and flushes pages after. Restore must not `setOps([])`
 * from that blob or it wipes a later shard ingest, and must not fall through
 * to the blob when shards exist (including an empty page after an erase).
 */

export type InkRestoreSource = "shards" | "blob" | "none";

export function inkRestoreSource(shardPages: number, blobOps: number): InkRestoreSource {
  const shards = Number.isFinite(shardPages) ? shardPages : 0;
  const blob = Number.isFinite(blobOps) ? blobOps : 0;
  if (shards > 0) return "shards";
  if (blob > 0) return "blob";
  return "none";
}

/** Seed the live book from pad JSON only when it actually carries strokes. */
export function shouldSeedInkFromBlob(ops: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(ops) && ops.length > 0;
}
