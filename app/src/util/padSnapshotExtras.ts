/**
 * Gather and apply the snapshot extras §2b added: ink, edges, source.
 *
 * Merge rules for two live devices (newest-wins ink, union edges, conflict
 * banner) are §2c and do not live here. Restore from a snapshot is a replace.
 */

import { gzipBytes } from "./gzip";
import { packEncodedInk } from "../canvas/inkCodec";
import { getAnnotateDoc } from "./annotateStore";
import {
  collectFootnoteBoards,
  whiteboardIdsOn,
} from "./footnoteWhiteboardStore";
import {
  annotateDocKey,
  footnoteWhiteboardDocKey,
  getInkPageRecords,
  type InkPageRecord,
  whiteboardDocKey,
} from "./inkPageStore";
import { edgesFor, edgeIsGone, putEdge } from "./noteLinks";
import {
  inkPageToSnapshot,
  padNodeRef,
  parseSnapshotEdges,
  type SnapshotInkPage,
} from "./padSnapshotPayload";
import type { PadSnapshot, PadSnapshotKind } from "./padSnapshotStore";
import { recordRollingSnapshots } from "./padSnapshotStore";
import { captureArtifactSnapshot, parseArtifactSnapshotBundle } from "./artifactSnapshot";
import { validateInk } from "./syncContent";

export interface PadSnapshotExtras {
  artifactBundle?: PadSnapshot["artifactBundle"];
  ink?: SnapshotInkPage[];
  edges?: PadSnapshot["edges"];
  source?: string;
  footnoteBoards?: PadSnapshot["footnoteBoards"];
  footnoteInk?: PadSnapshot["footnoteInk"];
}

/** One doc key's pages, gzipped, in the shape a snapshot stores them. */
async function inkPagesForSnapshot(docKey: string): Promise<SnapshotInkPage[]> {
  const out: SnapshotInkPage[] = [];
  for (const row of await getInkPageRecords(docKey, { strict: true })) {
    const gz = await gzForRecord(row);
    if (!gz) throw new Error(`Handwriting on page ${row.pageId} could not be backed up; the previous backup was kept.`);
    await validateInk(gz);
    out.push(inkPageToSnapshot({ pageId: row.pageId, updatedAt: row.updatedAt, gz }));
  }
  return out;
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
  const ink = await inkPagesForSnapshot(docKey);
  const annotate = kind === "annotate" ? await getAnnotateDoc(key) : null;
  const notebook = kind === "whiteboard" ? await (await import("./whiteboardStore")).getWhiteboardNotebook(key) : null;
  const artifactBundle = await captureArtifactSnapshot((annotate ?? notebook)?.artifacts);
  const docType = opts?.docType ?? annotate?.docType;
  const node = padNodeRef(kind, key, docType);
  const edges = await edgesFor(node);
  const source = opts?.source ?? annotate?.source;
  /*
   * Boards and their strokes, apart, the way they are stored.
   *
   * `collectFootnoteBoards` is slimmed here too — the blobs stopped carrying
   * `inkC` when scratch handwriting moved onto its own key, so keeping the fat
   * shape would only preserve whatever a pre-split blob happened to hold. The
   * strokes come from the shards instead, once per board, gzipped like the
   * document's own pages.
   */
  const footnoteBoards =
    kind === "annotate"
      ? await collectFootnoteBoards(key, annotate?.footnotes ?? [], { slim: false })
      : undefined;
  const footnoteInk: Record<string, SnapshotInkPage[]> = {};
  if (kind === "annotate") {
    for (const wbId of whiteboardIdsOn(annotate?.footnotes ?? [])) {
      const pages = await inkPagesForSnapshot(footnoteWhiteboardDocKey(key, wbId));
      if (pages.length > 0) footnoteInk[wbId] = pages;
    }
  }
  return {
    ...(artifactBundle ? { artifactBundle } : {}),
    ...(ink.length > 0 ? { ink } : {}),
    ...(edges.length > 0 ? { edges } : {}),
    ...(typeof source === "string" && source.length > 0 ? { source } : {}),
    ...(footnoteBoards && Object.keys(footnoteBoards).length > 0 ? { footnoteBoards } : {}),
    ...(Object.keys(footnoteInk).length > 0 ? { footnoteInk } : {}),
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
    | "ink"
    | "edges"
    | "source"
    | "board"
    | "footnotes"
    | "agent"
    | "name"
    | "footnoteBoards"
    | "footnoteInk"
    | "artifactBundle"
  >,
): Promise<void> {
  const bundle = parseArtifactSnapshotBundle(snap.artifactBundle, { kind, id: key });
  const { restoreArtifactSnapshot, restorePadSnapshotLocally } = await import("./artifactSnapshotRestore");
  if (bundle) await restoreArtifactSnapshot({ kind, id: key }, snap, bundle);
  else await restorePadSnapshotLocally({ kind, id: key }, snap);
  // Links are supplemental: restore their union after the book transaction.
  for (const edge of parseSnapshotEdges(snap.edges)) {
    if (!await edgeIsGone(edge.id)) await putEdge(edge);
  }
}
