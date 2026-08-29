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
import type { Edge } from "./noteLinks";
import type { SnapshotInkPage } from "./padSnapshotPayload";

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
  "ink" | "edges" | "source" | "footnoteBoards" | "footnoteInk"
>;

function boardWithoutInk(board: BoardBlob): BoardBlob {
  return {
    v: board.v,
    elements: board.elements,
    appState: board.appState,
    ...(board.inkPages ? { inkPages: board.inkPages } : {}),
    ...(board.files ? { files: board.files } : {}),
    ...(board.inkPalettes ? { inkPalettes: board.inkPalettes } : {}),
  };
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
  const extra = input.extras
    ? await input.extras()
    : {
        ...(input.ink && input.ink.length > 0 ? { ink: input.ink } : {}),
        ...(input.edges && input.edges.length > 0 ? { edges: input.edges } : {}),
        ...(typeof input.source === "string" ? { source: input.source } : {}),
      };
  const board = boardWithoutInk(input.board);
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
  let moved = 0;
  for (const tier of PAD_SNAPSHOT_TIERS) {
    const row = await getRecord(recordKey(kind, fromKey, tier.id));
    if (!row) continue;
    const already = await getRecord(recordKey(kind, toKey, tier.id));
    if (!already) {
      try {
        await run(STORE_SNAPSHOTS, "readwrite", (store) =>
          store.put({ ...row, key: toKey }, recordKey(kind, toKey, tier.id)),
        );
        moved += 1;
      } catch {
        // Could not copy — leave the original so a later run can retry.
        continue;
      }
    }
    try {
      await run(STORE_SNAPSHOTS, "readwrite", (store) =>
        store.delete(recordKey(kind, fromKey, tier.id)),
      );
    } catch {
      /* ignore */
    }
  }
  return moved;
}

export async function deletePadSnapshot(
  kind: PadSnapshotKind,
  key: string,
  tier: PadSnapshotTier,
): Promise<void> {
  try {
    await run(STORE_SNAPSHOTS, "readwrite", (store) => store.delete(recordKey(kind, key, tier)));
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
