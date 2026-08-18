/**
 * Dual-write pads to the harness. IndexedDB stays the working copy; the server
 * copy is historical. A pull never deletes local snapshots or bytes just
 * because the server omitted a row.
 */

import type {
  AnnotatePadDto,
  LcClient,
  PadSnapshotDto,
  WhiteboardPadDto,
} from "../api/client";
import { LcApiError as ApiError } from "../api/client";
import type { BoardBlob } from "../canvas/BoardHandle";
import {
  getAnnotateDoc,
  listAnnotateDocs,
  restoreAnnotateDoc,
  type AnnotateDoc,
  type DocType,
} from "./annotateStore";
import { getDocBytes, putDocBytes } from "./docBytes";
import type { DocFootnote } from "./docFootnotes";
import { run, STORE_SYNC_QUEUE } from "./idb";
import {
  getPadSnapshot,
  PAD_SNAPSHOT_TIERS,
  type PadSnapshot,
  type PadSnapshotKind,
} from "./padSnapshotStore";
import {
  getWhiteboardNotebook,
  listWhiteboardNotebooks,
  restoreWhiteboardNotebook,
  type WhiteboardNotebook,
} from "./whiteboardStore";

export const TOMBSTONE_COPY =
  "This removes it from the library on all devices. A copy stays on the PC and can be restored.";

export type PadSyncJobInput =
  | { op: "putWhiteboard"; body: WhiteboardPadDto }
  | { op: "putAnnotate"; body: AnnotatePadDto }
  | { op: "putSnapshot"; body: PadSnapshotDto }
  | { op: "putBytes"; hash: string; bytes: ArrayBuffer }
  | { op: "tombstone"; kind: "whiteboard" | "annotate"; padId: string };

export type PadSyncJob = PadSyncJobInput & { id: string };

const memoryQueue: PadSyncJob[] = [];

export function resetPadSyncQueueForTests(): void {
  memoryQueue.length = 0;
}

export function peekPadSyncQueueForTests(): PadSyncJob[] {
  return [...memoryQueue];
}

function jobId(): string {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function persistJob(job: PadSyncJob): Promise<void> {
  try {
    await run(STORE_SYNC_QUEUE, "readwrite", (store) => store.put(job, job.id));
  } catch {
    /* private browsing / quota — memory queue still holds it this session */
  }
}

async function dropJob(id: string): Promise<void> {
  const idx = memoryQueue.findIndex((job) => job.id === id);
  if (idx >= 0) memoryQueue.splice(idx, 1);
  try {
    await run(STORE_SYNC_QUEUE, "readwrite", (store) => store.delete(id));
  } catch {
    /* ignore */
  }
}

export async function enqueuePadSync(job: PadSyncJobInput): Promise<void> {
  const full: PadSyncJob = { ...job, id: jobId() };
  memoryQueue.push(full);
  await persistJob(full);
}

export async function pushWhiteboardPad(
  client: LcClient,
  notebook: WhiteboardNotebook,
): Promise<void> {
  const body: WhiteboardPadDto = {
    id: notebook.id,
    title: notebook.title,
    updated_at: notebook.updatedAt,
    page_count: notebook.pageCount,
    board: notebook.board,
    agent: notebook.agent ?? [],
  };
  try {
    await client.putWhiteboardPad(notebook.id, body);
  } catch (cause) {
    if (isConflict(cause)) return;
    await enqueuePadSync({ op: "putWhiteboard", body });
  }
}

export async function pushAnnotatePad(client: LcClient, doc: AnnotateDoc): Promise<void> {
  const body: AnnotatePadDto = {
    id: doc.id,
    name: doc.name,
    hash: doc.hash,
    doc_type: doc.docType,
    updated_at: doc.updatedAt,
    source: doc.source,
    footnotes: doc.footnotes ?? [],
    board: doc.board,
    agent: doc.agent ?? [],
  };
  try {
    await client.putAnnotatePad(doc.id, body);
  } catch (cause) {
    if (isConflict(cause)) return;
    await enqueuePadSync({ op: "putAnnotate", body });
  }
}

export async function pushRecentSnapshots(
  client: LcClient,
  kind: PadSnapshotKind,
  key: string,
): Promise<void> {
  const { listPadSnapshots, getPadSnapshot } = await import("./padSnapshotStore");
  const metas = await listPadSnapshots(kind, key);
  for (const meta of metas) {
    const row = await getPadSnapshot(kind, key, meta.tier);
    if (row) await pushPadSnapshot(client, row);
  }
}

export async function pushPadSnapshot(client: LcClient, snap: PadSnapshot): Promise<void> {
  const body: PadSnapshotDto = {
    kind: snap.kind,
    key: snap.key,
    tier: snap.tier,
    written_at: snap.writtenAt,
    payload: {
      name: snap.name,
      board: snap.board,
      footnotes: snap.footnotes,
      agent: snap.agent,
      pageCount: snap.pageCount,
    },
  };
  try {
    await client.putPadSnapshot(body);
  } catch {
    await enqueuePadSync({ op: "putSnapshot", body });
  }
}

export async function pushDocBytes(client: LcClient, hash: string, bytes: ArrayBuffer): Promise<void> {
  try {
    await client.putDocBytes(hash, bytes);
  } catch {
    await enqueuePadSync({ op: "putBytes", hash, bytes });
  }
}

export async function deletePadEverywhere(
  client: LcClient,
  kind: "whiteboard" | "annotate",
  padId: string,
  localDelete: () => Promise<void>,
): Promise<void> {
  await localDelete();
  await tombstonePad(client, kind, padId);
}

export async function tombstonePad(
  client: LcClient,
  kind: "whiteboard" | "annotate",
  padId: string,
): Promise<void> {
  try {
    if (kind === "whiteboard") await client.tombstoneWhiteboardPad(padId);
    else await client.tombstoneAnnotatePad(padId);
  } catch {
    await enqueuePadSync({ op: "tombstone", kind, padId });
  }
}

export async function restoreArchivedPad(
  client: LcClient,
  kind: "whiteboard" | "annotate",
  padId: string,
): Promise<void> {
  if (kind === "whiteboard") await client.restoreWhiteboardPad(padId);
  else await client.restoreAnnotatePad(padId);
  await pullPads(client);
}

export async function flushPadSyncQueue(client: LcClient): Promise<void> {
  const jobs = [...memoryQueue];
  for (const job of jobs) {
    try {
      if (job.op === "putWhiteboard") await client.putWhiteboardPad(job.body.id, job.body);
      else if (job.op === "putAnnotate") await client.putAnnotatePad(job.body.id, job.body);
      else if (job.op === "putSnapshot") await client.putPadSnapshot(job.body);
      else if (job.op === "putBytes") await client.putDocBytes(job.hash, job.bytes);
      else if (job.op === "tombstone") {
        if (job.kind === "whiteboard") await client.tombstoneWhiteboardPad(job.padId);
        else await client.tombstoneAnnotatePad(job.padId);
      }
      await dropJob(job.id);
    } catch (cause) {
      if (isConflict(cause)) {
        await dropJob(job.id);
        continue;
      }
      return;
    }
  }
}

function isConflict(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409;
}

function boardLooksCorrupt(board: unknown): boolean {
  if (!board || typeof board !== "object") return true;
  const blob = board as BoardBlob;
  return blob.v !== 1 || !Array.isArray(blob.elements);
}

export async function pullPads(client: LcClient): Promise<void> {
  const [whiteboards, annotate, wbArchive, anArchive] = await Promise.all([
    client.listWhiteboardPads(),
    client.listAnnotatePads(),
    client.listWhiteboardArchive().catch(() => [] as WhiteboardPadDto[]),
    client.listAnnotateArchive().catch(() => [] as AnnotatePadDto[]),
  ]);

  const localWb = new Set(listWhiteboardNotebooks().map((row) => row.id));
  for (const row of whiteboards) {
    const local = await getWhiteboardNotebook(row.id);
    const missing = !local || boardLooksCorrupt(local.board);
    if (!missing) continue;
    await restoreWhiteboardNotebook({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      pageCount: row.page_count,
      board: row.board as BoardBlob,
      agent: Array.isArray(row.agent) ? row.agent : [],
    });
  }

  const localAn = new Set(listAnnotateDocs().map((row) => row.id));
  for (const row of annotate) {
    const local = await getAnnotateDoc(row.id);
    const missing = !local || boardLooksCorrupt(local.board);
    if (!missing) continue;
    await restoreAnnotateDoc({
      id: row.id,
      name: row.name,
      hash: row.hash,
      docType: (row.doc_type as DocType) || "markdown",
      updatedAt: row.updated_at,
      source: row.source ?? "",
      board: row.board as BoardBlob,
      footnotes: Array.isArray(row.footnotes) ? (row.footnotes as DocFootnote[]) : [],
      agent: Array.isArray(row.agent) ? row.agent : [],
    });
    if (row.hash) {
      const have = await getDocBytes(row.hash);
      if (!have) {
        const bytes = await client.getDocBytes(row.hash);
        if (bytes && bytes.byteLength > 0) await putDocBytes(row.hash, bytes);
      }
    }
  }

  for (const row of wbArchive) {
    if (localWb.has(row.id)) {
      const { deleteWhiteboardNotebook } = await import("./whiteboardStore");
      await deleteWhiteboardNotebook(row.id).catch(() => {});
    }
  }
  for (const row of anArchive) {
    if (localAn.has(row.id)) {
      const { deleteAnnotateDoc } = await import("./annotateStore");
      await deleteAnnotateDoc(row.id).catch(() => {});
    }
  }

  for (const row of [...whiteboards, ...wbArchive]) {
    await fillMissingSnapshots(client, "whiteboard", row.id);
  }
  /*
   * Annotate snapshots are keyed by the sidecar id, like whiteboard's.
   *
   * They used to be keyed by the annotated file's hash, which meant two
   * annotation sets on one PDF would have shared all three tiers. Snapshots
   * the daemon still holds under a hash are simply not pulled — they belong to
   * a key nothing asks for any more, and the live pad rows carry the ink.
   */
  for (const row of [...annotate, ...anArchive]) {
    await fillMissingSnapshots(client, "annotate", row.id);
  }
}

async function fillMissingSnapshots(
  client: LcClient,
  kind: PadSnapshotKind,
  key: string,
): Promise<void> {
  let remote: PadSnapshotDto[] = [];
  try {
    remote = await client.getPadSnapshots(kind, key);
  } catch {
    return;
  }
  const { run: idbRun, STORE_SNAPSHOTS } = await import("./idb");
  for (const row of remote) {
    const local = await getPadSnapshot(kind, key, row.tier as PadSnapshot["tier"]);
    if (local) continue;
    const payload = (row.payload ?? {}) as Partial<PadSnapshot>;
    const snap: PadSnapshot = {
      kind,
      key,
      tier: row.tier as PadSnapshot["tier"],
      writtenAt: row.written_at,
      name: payload.name ?? key,
      board: payload.board as BoardBlob,
      footnotes: payload.footnotes,
      agent: payload.agent,
      pageCount: payload.pageCount,
    };
    try {
      await idbRun(STORE_SNAPSHOTS, "readwrite", (store) =>
        store.put(snap, `${kind}:${key}:${row.tier}`),
      );
    } catch {
      /* ignore */
    }
  }
}

export { PAD_SNAPSHOT_TIERS };
