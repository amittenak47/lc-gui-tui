/**
 * Gather and apply the snapshot extras §2b added: ink, edges, source.
 *
 * Merge rules for two live devices (newest-wins ink, union edges, conflict
 * banner) are §2c and do not live here. Restore from a snapshot is a replace.
 */

import { gzipBytes } from "./gzip";
import { packEncodedInk } from "../canvas/inkCodec";
import { getAnnotateDoc, saveAnnotateDoc } from "./annotateStore";
import {
  annotateDocKey,
  getInkPageRecords,
  inkPageKey,
  type InkPageRecord,
  whiteboardDocKey,
} from "./inkPageStore";
import { withStore, STORE_INK_PAGES } from "./idb";
import { edgesFor, putEdge } from "./noteLinks";
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
  return {
    ...(ink.length > 0 ? { ink } : {}),
    ...(edges.length > 0 ? { edges } : {}),
    ...(typeof source === "string" && source.length > 0 ? { source } : {}),
  };
}

export async function recordPadSnapshotsWithExtras(
  input: Parameters<typeof recordRollingSnapshots>[0],
): Promise<PadSnapshot[]> {
  const extras = await gatherPadSnapshotExtras(input.kind, input.key, {
    source: input.source,
  });
  return recordRollingSnapshots({ ...input, ...extras });
}

export async function applyPadSnapshotExtras(
  kind: PadSnapshotKind,
  key: string,
  snap: Pick<PadSnapshot, "ink" | "edges" | "source" | "board" | "footnotes" | "agent" | "name">,
): Promise<void> {
  const docKey = kind === "whiteboard" ? whiteboardDocKey(key) : annotateDocKey(key);
  const ink = parseSnapshotInk(snap.ink);
  if (ink.length > 0) {
    const rows: InkPageRecord[] = [];
    for (const page of ink) {
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
  }
  for (const edge of parseSnapshotEdges(snap.edges)) {
    await putEdge(edge);
  }
  if (kind !== "annotate") return;
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
