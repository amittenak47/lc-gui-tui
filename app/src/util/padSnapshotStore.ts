/**
 * Rolling backups for document pads and whiteboard notebooks.
 *
 * Live autosave (3s / 15s / 1m) already writes the library entry. These are
 * extra copies that update at most once per window — 2h, 24h, 7d — and only
 * when that same autosave actually ran (the writer is editing, not just
 * reading). Restore is a library-dialog choice, not a hidden file on disk.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { run, STORE_SNAPSHOTS } from "./idb";
import type { DocFootnote } from "./docFootnotes";

export type PadSnapshotKind = "annotate" | "whiteboard";
export type PadSnapshotTier = "2h" | "24h" | "7d";

export const PAD_SNAPSHOT_TIERS: ReadonlyArray<{
  id: PadSnapshotTier;
  maxAgeMs: number;
  label: string;
}> = [
  { id: "2h", maxAgeMs: 2 * 60 * 60 * 1000, label: "2 hours" },
  { id: "24h", maxAgeMs: 24 * 60 * 60 * 1000, label: "24 hours" },
  { id: "7d", maxAgeMs: 7 * 24 * 60 * 60 * 1000, label: "7 days" },
];

export interface PadSnapshot {
  kind: PadSnapshotKind;
  key: string;
  tier: PadSnapshotTier;
  writtenAt: number;
  name: string;
  board: BoardBlob;
  footnotes?: DocFootnote[];
  agent?: unknown[];
  pageCount?: number;
}

export interface PadSnapshotMeta {
  kind: PadSnapshotKind;
  key: string;
  tier: PadSnapshotTier;
  writtenAt: number;
  name: string;
}

function recordKey(kind: PadSnapshotKind, key: string, tier: PadSnapshotTier): string {
  return `${kind}:${key}:${tier}`;
}

/** True when this tier has never been written, or its window has elapsed. */
export function shouldWriteTier(
  lastWrittenAt: number | null | undefined,
  now: number,
  maxAgeMs: number,
): boolean {
  if (lastWrittenAt == null || !Number.isFinite(lastWrittenAt)) return true;
  return now - lastWrittenAt >= maxAgeMs;
}

async function getRecord(id: string): Promise<PadSnapshot | null> {
  try {
    const row = await run<PadSnapshot | undefined>(STORE_SNAPSHOTS, "readonly", (store) =>
      store.get(id),
    );
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * After a live autosave: copy into any tier whose window has elapsed.
 *
 * Failures are silent — the live library entry already landed, and a snapshot
 * that cannot write must not fail the stroke that just saved.
 */
export async function recordRollingSnapshots(input: {
  kind: PadSnapshotKind;
  key: string;
  name: string;
  board: BoardBlob;
  footnotes?: DocFootnote[];
  agent?: unknown[];
  pageCount?: number;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const key = input.key.trim();
  if (!key) return;
  for (const tier of PAD_SNAPSHOT_TIERS) {
    const id = recordKey(input.kind, key, tier.id);
    const existing = await getRecord(id);
    if (!shouldWriteTier(existing?.writtenAt, now, tier.maxAgeMs)) continue;
    const row: PadSnapshot = {
      kind: input.kind,
      key,
      tier: tier.id,
      writtenAt: now,
      name: input.name,
      board: input.board,
      ...(input.footnotes ? { footnotes: input.footnotes } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.pageCount != null ? { pageCount: input.pageCount } : {}),
    };
    try {
      await run(STORE_SNAPSHOTS, "readwrite", (store) => store.put(row, id));
    } catch {
      /* quota / private browsing — live save already succeeded */
    }
  }
}

export async function listPadSnapshots(
  kind: PadSnapshotKind,
  key: string,
): Promise<PadSnapshotMeta[]> {
  const out: PadSnapshotMeta[] = [];
  for (const tier of PAD_SNAPSHOT_TIERS) {
    const row = await getRecord(recordKey(kind, key, tier.id));
    if (!row) continue;
    out.push({
      kind: row.kind,
      key: row.key,
      tier: row.tier,
      writtenAt: row.writtenAt,
      name: row.name,
    });
  }
  return out;
}

export async function getPadSnapshot(
  kind: PadSnapshotKind,
  key: string,
  tier: PadSnapshotTier,
): Promise<PadSnapshot | null> {
  return getRecord(recordKey(kind, key, tier));
}

export async function deletePadSnapshots(kind: PadSnapshotKind, key: string): Promise<void> {
  for (const tier of PAD_SNAPSHOT_TIERS) {
    try {
      await run(STORE_SNAPSHOTS, "readwrite", (store) =>
        store.delete(recordKey(kind, key, tier.id)),
      );
    } catch {
      /* ignore */
    }
  }
}
