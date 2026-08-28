/**
 * Gather and apply the snapshot extras §2b added: ink, edges, source.
 *
 * Merge rules for two live devices (newest-wins ink, union edges, conflict
 * banner) are §2c and do not live here. Restore from a snapshot is a replace.
 */

import { gzipBytes } from "./gzip";
import { packEncodedInk } from "../canvas/inkCodec";
import { getAnnotateDoc, saveAnnotateDoc } from "./annotateStore";
import { applyFootnoteBoards, collectFootnoteBoards } from "./footnoteWhiteboardStore";
import {
  annotateDocKey,
  deleteInkPages,
  getInkPageRecords,
  inkPageKey,
  type InkPageRecord,
  whiteboardDocKey,
} from "./inkPageStore";
import { withStore, STORE_INK_PAGES } from "./idb";
import { edgesFor, edgeIsGone, putEdge } from "./noteLinks";
import {
  inkPageToSnapshot,
  padNodeRef,
  parseSnapshotEdges,
  parseSnapshotInk,
  parseSnapshotSource,
  snapshotInkToBytes,
  type SnapshotInkPage,
} from "./padSnapshotPayload";
import type { PadSnapshot, PadSnapshotKind } from "./padSnapshotStore";
import { recordRollingSnapshots } from "./padSnapshotStore";

export interface PadSnapshotExtras {
  ink?: SnapshotInkPage[];
  edges?: PadSnapshot["edges"];
  source?: string;
  footnoteBoards?: PadSnapshot["footnoteBoards"];
}

async function gzForRecord(row: InkPageRecord): Promise<Uint8Array<ArrayBuffer> | null> {
  if (row.gz && row.gz.byteLength > 0) {
    return row.gz instanceof Uint8Array
      ? (row.gz as Uint8Array<ArrayBuffer>)
      : new Uint8Array(row.gz);
  }
  if (!row.inkC) return null;
  try {
    return await gzipBytes(packEncodedInk(row.inkC));
  } catch {
    return null;
  }
}

export async function gatherPadSnapshotExtras(
  kind: PadSnapshotKind,
  key: string,
  opts?: { source?: string; docType?: string },
): Promise<PadSnapshotExtras> {
  const docKey = kind === "whiteboard" ? whiteboardDocKey(key) : annotateDocKey(key);
  const records = await getInkPageRecords(docKey);
  const ink: SnapshotInkPage[] = [];
  for (const row of records) {
    const gz = await gzForRecord(row);
    if (!gz) continue;
    ink.push(inkPageToSnapshot({ pageId: row.pageId, updatedAt: row.updatedAt, gz }));
  }
  const annotate = kind === "annotate" ? await getAnnotateDoc(key) : null;
  const docType = opts?.docType ?? annotate?.docType;
  const node = padNodeRef(kind, key, docType);
  const edges = await edgesFor(node);
  const source = opts?.source ?? annotate?.source;
  const footnoteBoards =
    kind === "annotate" ? await collectFootnoteBoards(key, annotate?.footnotes ?? []) : undefined;
  return {
    ...(ink.length > 0 ? { ink } : {}),
    ...(edges.length > 0 ? { edges } : {}),
    ...(typeof source === "string" && source.length > 0 ? { source } : {}),
    ...(footnoteBoards && Object.keys(footnoteBoards).length > 0 ? { footnoteBoards } : {}),
  };
}

export async function recordPadSnapshotsWithExtras(
  input: Parameters<typeof recordRollingSnapshots>[0],
): Promise<PadSnapshot[]> {
  return recordRollingSnapshots({
    kind: input.kind,
    key: input.key,
    name: input.name,
    board: input.board,
    footnotes: input.footnotes,
    agent: input.agent,
    pageCount: input.pageCount,
    now: input.now,
    extras: () =>
      gatherPadSnapshotExtras(input.kind, input.key, {
        source: input.source,
      }),
  });
}

export async function applyPadSnapshotExtras(
  kind: PadSnapshotKind,
  key: string,
  snap: Pick<
    PadSnapshot,
    "ink" | "edges" | "source" | "board" | "footnotes" | "agent" | "name" | "footnoteBoards"
  >,
): Promise<void> {
  const docKey = kind === "whiteboard" ? whiteboardDocKey(key) : annotateDocKey(key);
  /*
   * A restore replaces the document's ink. It does not merge into it.
   *
   * Two things went wrong when this only ever `put` the pages the snapshot
   * named. Anything drawn *after* the snapshot survived on a page the snapshot
   * had nothing to say about, so restoring to before a page existed left that
   * page's strokes standing. And a snapshot written before the board blob
   * stopped carrying `inkC` has no `ink` at all — it took this branch, wrote
   * nothing, and `restoreInk` then found the live document's pages still in
   * place and ingested *those*, so the restore quietly returned today's
   * handwriting instead of the snapshot's.
   *
   * Clearing first fixes both, and it is what makes the fallback work: with the
   * store empty, `restoreInk` falls through to the board blob, which is exactly
   * where an older snapshot keeps its strokes.
   */
  await deleteInkPages(docKey);
  const rows: InkPageRecord[] = [];
  for (const page of parseSnapshotInk(snap.ink)) {
    const decoded = snapshotInkToBytes(page);
    if (!decoded) continue;
    rows.push({
      v: 1,
      docKey,
      pageId: decoded.pageId,
      gz: decoded.gz,
      dirty: false,
      updatedAt: decoded.updatedAt,
    });
  }
  if (rows.length > 0) {
    await withStore(STORE_INK_PAGES, "readwrite", (store) => {
      for (const row of rows) store.put(row, inkPageKey(docKey, row.pageId));
    });
  }
  for (const edge of parseSnapshotEdges(snap.edges)) {
    if (await edgeIsGone(edge.id)) continue;
    await putEdge(edge);
  }
  if (kind !== "annotate") return;
  if (snap.footnoteBoards) await applyFootnoteBoards(key, snap.footnoteBoards);
  const source = parseSnapshotSource(snap.source);
  if (source == null) return;
  const existing = await getAnnotateDoc(key);
  if (!existing) return;
  await saveAnnotateDoc({
    id: existing.id,
    name: snap.name || existing.name,
    hash: existing.hash,
    docType: existing.docType,
    source,
    board: snap.board ?? existing.board,
    footnotes: snap.footnotes ?? existing.footnotes,
    agent: Array.isArray(snap.agent) ? snap.agent : existing.agent,
  });
}
