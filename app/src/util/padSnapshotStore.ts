/**
 * Rolling backups for document pads and whiteboard notebooks.
 *
 * Live autosave (3s / 15s / 1m) already writes the library entry. These are
 * extra copies that update at most once per window — 2h, 24h, 7d — and only
 * when that same autosave actually ran (the writer is editing, not just
 * reading). Restore is a library-dialog choice, not a hidden file on disk.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { run, STORE_SNAPSHOTS, withStore } from "./idb";
import type { DocFootnote } from "./docFootnotes";
import type { Edge } from "./noteLinks";
import type { SnapshotInkPage } from "./padSnapshotPayload";
import { parseArtifactSnapshotBundle, type ArtifactSnapshotBundle } from "./artifactSnapshot";
import { newBookToken } from "./bookCoordinator";

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
  /** Stable identity for an additional recovered copy of a rolling tier. */
  snapshotId?: string;
  artifactBundle?: ArtifactSnapshotBundle;
  kind: PadSnapshotKind;
  key: string;
  tier: PadSnapshotTier;
  writtenAt: number;
  name: string;
  board: BoardBlob;
  footnotes?: DocFootnote[];
  agent?: unknown[];
  pageCount?: number;
  /** Per-page gzip ink. The board blob no longer carries the same strokes. */
  ink?: SnapshotInkPage[];
  /** Graph edges that name this pad. Apply is idempotent on edge id. */
  edges?: Edge[];
  /** Source text; live row has it, snapshots did not. */
  source?: string;
  /** Footnote-owned scratch boards, keyed by whiteboard id. */
  footnoteBoards?: Record<string, { board: BoardBlob; pageCount: number }>;
  /**
   * Per-page gzip ink for each scratch board, keyed by whiteboard id.
   *
   * Their blobs stopped carrying `inkC` when scratch handwriting moved onto
   * its own hub key, so a snapshot that only kept `footnoteBoards` would
   * restore the boards as blank paper. Same shape as `ink` above, once per
   * board — a restore is a replace, and this is what it replaces them with.
   */
  footnoteInk?: Record<string, SnapshotInkPage[]>;
}

export type PadSnapshotExtras = Pick<
  PadSnapshot,
  "ink" | "edges" | "source" | "footnoteBoards" | "footnoteInk" | "artifactBundle"
>;

function boardWithoutInk(board: BoardBlob): BoardBlob {
  // Inline legacy ink is not redundant until a complete conversion has been
  // proved. Keep it and any unknown authored board fields in the backup.
  return { ...board };
}

export interface PadSnapshotMeta {
  snapshotId?: string;
  kind: PadSnapshotKind;
  key: string;
  tier: PadSnapshotTier;
  writtenAt: number;
  name: string;
}

export function padSnapshotKey(kind: PadSnapshotKind, key: string, tier: PadSnapshotTier): string {
  return `${kind}:${key}:${tier}`;
}
const recordKey = padSnapshotKey;

export function recoveredPadSnapshotKey(kind: PadSnapshotKind, key: string, tier: PadSnapshotTier,
  sourceKind: string, sourceId: string): string {
  return `recovered:${JSON.stringify([kind, key, tier, sourceKind, sourceId])}`;
}

async function snapshotRecords(): Promise<Array<{ id: string; row: PadSnapshot }>> {
  const out: Array<{ id: string; row: PadSnapshot }> = [];
  await withStore(STORE_SNAPSHOTS, "readonly", store => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const row = cursor.value as PadSnapshot;
      if (row && (row.kind === "annotate" || row.kind === "whiteboard") && typeof row.key === "string"
        && PAD_SNAPSHOT_TIERS.some(tier => tier.id === row.tier)) out.push({ id: String(cursor.key), row });
      cursor.continue();
    };
  });
  return out;
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
  ink?: SnapshotInkPage[];
  edges?: Edge[];
  source?: string;
  extras?: () => Promise<PadSnapshotExtras>;
  now?: number;
}): Promise<PadSnapshot[]> {
  const now = input.now ?? Date.now();
  const key = input.key.trim();
  if (!key) return [];
  const due: PadSnapshotTier[] = [];
  for (const tier of PAD_SNAPSHOT_TIERS) {
    const existing = await getRecord(recordKey(input.kind, key, tier.id));
    if (!shouldWriteTier(existing?.writtenAt, now, tier.maxAgeMs)) continue;
    due.push(tier.id);
  }
  if (due.length === 0) return [];
  const extra: PadSnapshotExtras = input.extras
    ? await input.extras()
    : {
        ...(input.ink && input.ink.length > 0 ? { ink: input.ink } : {}),
        ...(input.edges && input.edges.length > 0 ? { edges: input.edges } : {}),
        ...(typeof input.source === "string" ? { source: input.source } : {}),
      };
  const board = boardWithoutInk(input.board);
  const artifactBundle = parseArtifactSnapshotBundle(extra.artifactBundle, { kind: input.kind, id: key });
  const written: PadSnapshot[] = [];
  for (const tierId of due) {
    const id = recordKey(input.kind, key, tierId);
    const row: PadSnapshot = {
      kind: input.kind,
      key,
      tier: tierId,
      writtenAt: now,
      name: input.name,
      board,
      ...(artifactBundle ? { artifactBundle } : {}),
      ...(input.footnotes ? { footnotes: input.footnotes } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.pageCount != null ? { pageCount: input.pageCount } : {}),
      ...(extra.ink && extra.ink.length > 0 ? { ink: extra.ink } : {}),
      ...(extra.edges && extra.edges.length > 0 ? { edges: extra.edges } : {}),
        ...(typeof extra.source === "string" ? { source: extra.source } : {}),
        ...(extra.footnoteBoards && Object.keys(extra.footnoteBoards).length > 0
          ? { footnoteBoards: extra.footnoteBoards }
          : {}),
        ...(extra.footnoteInk && Object.keys(extra.footnoteInk).length > 0
          ? { footnoteInk: extra.footnoteInk }
          : {}),
    };
    try {
      await run(STORE_SNAPSHOTS, "readwrite", (store) => store.put(row, id));
      written.push(row);
    } catch {
      /* quota / private browsing — live save already succeeded */
    }
  }
  return written;
}

export async function listPadSnapshots(
  kind: PadSnapshotKind,
  key: string,
): Promise<PadSnapshotMeta[]> {
  const records = (await snapshotRecords()).filter(({ row }) => row.kind === kind && row.key === key);
  return records.sort((a, b) => PAD_SNAPSHOT_TIERS.findIndex(tier => tier.id === a.row.tier)
    - PAD_SNAPSHOT_TIERS.findIndex(tier => tier.id === b.row.tier)
    || b.row.writtenAt - a.row.writtenAt || a.id.localeCompare(b.id))
    .map(({ id, row }) => ({ kind: row.kind, key: row.key, tier: row.tier,
      writtenAt: row.writtenAt, name: row.name, snapshotId: id }));
}

/** Includes retained backups whose live parent has been removed. */
export async function listAllPadSnapshots(): Promise<PadSnapshotMeta[]> {
  return (await snapshotRecords()).map(({ id, row }) => ({ kind: row.kind, key: row.key,
    tier: row.tier, writtenAt: row.writtenAt, name: row.name, snapshotId: id }));
}

export async function getPadSnapshot(
  kind: PadSnapshotKind,
  key: string,
  tier: PadSnapshotTier,
  snapshotId?: string,
): Promise<PadSnapshot | null> {
  const id = snapshotId ?? recordKey(kind, key, tier);
  const row = await getRecord(id);
  // A supplied copy ID is never authority to read a different book/tier.
  return row?.kind === kind && row.key === key && row.tier === tier
    ? { ...row, ...(snapshotId ? { snapshotId: id } : {}) } : null;
}

/**
 * Move a pad's three tiers from one key to another.
 *
 * Only used by the annotate hash-to-id migration. A tier already present under
 * the destination wins — the migration runs after the app has been writing
 * id-keyed snapshots, so a newer id-keyed tier must not be clobbered by the
 * stale hash-keyed one it replaced.
 */
export async function renamePadSnapshots(
  kind: PadSnapshotKind,
  fromKey: string,
  toKey: string,
): Promise<number> {
  if (!fromKey || !toKey || fromKey === toKey) return 0;
  let moved = 0;
  // Resolve source/destination collisions in one transaction. A destination
  // tier retains its existing copy and receives the source as an extra backup.
  await withStore(STORE_SNAPSHOTS, "readwrite", store => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const row = cursor.value as PadSnapshot;
      if (!row || row.kind !== kind || row.key !== fromKey) { cursor.continue(); return; }
      const sourceId = String(cursor.key);
      const targetId = sourceId === recordKey(kind, fromKey, row.tier)
        ? recordKey(kind, toKey, row.tier)
        : recoveredPadSnapshotKey(kind, toKey, row.tier, "lc.docs", `rename:${sourceId}`);
      const target = store.get(targetId);
      target.onsuccess = () => {
        const candidateId = target.result === undefined ? targetId
          : recoveredPadSnapshotKey(kind, toKey, row.tier, "lc.docs", `rename:${sourceId}`);
        const candidate = store.get(candidateId);
        candidate.onsuccess = () => {
          const id = candidate.result === undefined ? candidateId
            : recoveredPadSnapshotKey(kind, toKey, row.tier, "lc.docs", `rename:${sourceId}:${newBookToken()}`);
          store.put({ ...row, key: toKey, ...(id === recordKey(kind, toKey, row.tier)
            ? { snapshotId: undefined } : { snapshotId: id }) }, id);
          cursor.delete();
          moved++;
          cursor.continue();
        };
      };
    };
  });
  return moved;
}

export async function deletePadSnapshot(
  kind: PadSnapshotKind,
  key: string,
  tier: PadSnapshotTier,
  snapshotId?: string,
): Promise<void> {
  try {
    const row = await getPadSnapshot(kind, key, tier, snapshotId);
    if (row) await run(STORE_SNAPSHOTS, "readwrite", (store) => store.delete(snapshotId ?? recordKey(kind, key, tier)));
  } catch {
    /* ignore */
  }
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
