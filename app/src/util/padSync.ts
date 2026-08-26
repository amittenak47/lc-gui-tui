/**
 * Dual-write pads to the harness. IndexedDB stays the working copy; the server
 * copy is historical. A pull never deletes local snapshots or bytes just
 * because the server omitted a row.
 */

import type {
  AnnotatePadDto,
  LcClient,
  PadSnapshotDto,
  ProblemPadDto,
  WhiteboardPadDto,
} from "../api/client";
import { LcApiError as ApiError } from "../api/client";
import type { BoardBlob } from "../canvas/BoardHandle";
import {
  deleteAnnotateDoc,
  getAnnotateDoc,
  listAnnotateDocs,
  listAnnotateTrash,
  markAnnotateDeleteAcked,
  restoreAnnotateDoc,
  restoreAnnotateFromTrash,
  trashAnnotateDoc,
  markAnnotateHubAck,
  type AnnotateDoc,
  type DocType,
} from "./annotateStore";
import { isAndroidDevice } from "./androidDevice";
import { isCameraBusy, yieldToIdle } from "./cameraBusy";
import { bytesMatchDocHash, getDocBytes, putDocBytes } from "./docBytes";
import type { DocFootnote } from "./docFootnotes";
import { run, STORE_SYNC_QUEUE } from "./idb";
import { loadPadHub, loadPadSyncSince, savePadSyncSince } from "./padHub";
import { loadHubAutosync } from "./hubAutoSyncPref";
import { syncDocChunks } from "./docChunkSync";
import { noteInkConflicts } from "./inkConflicts";
import { syncEdges, syncInkPages, type InkPadKind } from "./inkSync";
import {
  getPadSnapshot,
  PAD_SNAPSHOT_TIERS,
  type PadSnapshot,
  type PadSnapshotKind,
} from "./padSnapshotStore";
import {
  deleteProblemBoard,
  getProblemBoard,
  markProblemHubAck,
  putProblemBoard,
  type ProblemBoardRecord,
} from "./problemBoardStore";
import {
  deleteWhiteboardNotebook,
  getWhiteboardNotebook,
  listWhiteboardNotebooks,
  listWhiteboardTrash,
  markWhiteboardDeleteAcked,
  restoreWhiteboardFromTrash,
  restoreWhiteboardNotebook,
  trashWhiteboardNotebook,
  markWhiteboardHubAck,
  type WhiteboardNotebook,
} from "./whiteboardStore";

export const TOMBSTONE_COPY =
  "This removes it from the library. Kept on this device for three days.";

/** How often a device asks the hub (or local pads.db) what changed. */
export const PAD_SYNC_PING_MS = 15_000;

/** First idle kick after open — Android waits longer so a flick can start. */
export const PAD_SYNC_IDLE_KICK_MS_DESKTOP = 400;
export const PAD_SYNC_IDLE_KICK_MS_ANDROID = 1000;

export function padSyncIdleKickMs(): number {
  return isAndroidDevice() ? PAD_SYNC_IDLE_KICK_MS_ANDROID : PAD_SYNC_IDLE_KICK_MS_DESKTOP;
}

let padSyncPingInFlight = false;
let idlePadSyncTimer: ReturnType<typeof setTimeout> | 0 = 0;

/** After a dead hub, do not retry on the 15s tick until this time. */
let hubBackoffUntil = 0;
let hubBackoffMs = 20_000;
const HUB_BACKOFF_MIN_MS = 20_000;
const HUB_BACKOFF_MAX_MS = 5 * 60_000;

export const PAD_TRASH_OP_QUEUE_CAP = 8;

export const PAD_HUB_WINDOW_EVENT = "lc-pad-hub";

export type PadHubWindowDetail = {
  kind: PadKindSync;
  id: string;
  op: "reload" | "close";
};

function emitPadHub(detail: PadHubWindowDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PAD_HUB_WINDOW_EVENT, { detail }));
}

function splitProblemPadId(id: string): { dataset: string; taskId: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  return { dataset: id.slice(0, slash), taskId: id.slice(slash + 1) };
}

export type PadKindSync = "whiteboard" | "annotate" | "problem";

export type PadSyncJobInput =
  | { op: "putWhiteboard"; body: WhiteboardPadDto }
  | { op: "putAnnotate"; body: AnnotatePadDto }
  | { op: "putProblem"; body: ProblemPadDto }
  | { op: "putSnapshot"; body: PadSnapshotDto }
  | { op: "putBytes"; hash: string; bytes: ArrayBuffer }
  | { op: "deletePad"; kind: PadKindSync; padId: string; seq: number }
  | { op: "restorePad"; kind: PadKindSync; padId: string; seq: number };

export type PadSyncJob = PadSyncJobInput & { id: string };

const memoryQueue: PadSyncJob[] = [];

export function resetPadSyncQueueForTests(): void {
  memoryQueue.length = 0;
  hubBackoffUntil = 0;
  hubBackoffMs = HUB_BACKOFF_MIN_MS;
}

export function peekPadSyncQueueForTests(): PadSyncJob[] {
  return [...memoryQueue];
}

function hubBackoffActive(): boolean {
  return loadPadHub() != null && Date.now() < hubBackoffUntil;
}

function noteHubPingOk(): void {
  hubBackoffUntil = 0;
  hubBackoffMs = HUB_BACKOFF_MIN_MS;
}

function noteHubPingFail(): void {
  if (!loadPadHub()) return;
  hubBackoffUntil = Date.now() + hubBackoffMs;
  hubBackoffMs = Math.min(HUB_BACKOFF_MAX_MS, hubBackoffMs * 2);
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
  if (job.op === "putWhiteboard") {
    await dropMatching((entry) => entry.op === "putWhiteboard" && entry.body.id === job.body.id);
  }
  if (job.op === "putAnnotate") {
    await dropMatching((entry) => entry.op === "putAnnotate" && entry.body.id === job.body.id);
  }
  if (job.op === "putProblem") {
    await dropMatching((entry) => entry.op === "putProblem" && entry.body.id === job.body.id);
  }
  if (job.op === "deletePad") {
    await dropMatching(
      (entry) => entry.op === "deletePad" && entry.kind === job.kind && entry.padId === job.padId,
    );
  }
  if (job.op === "restorePad") {
    await dropMatching(
      (entry) => entry.op === "restorePad" && entry.kind === job.kind && entry.padId === job.padId,
    );
  }
  const full: PadSyncJob = { ...job, id: jobId() };
  memoryQueue.push(full);
  await persistJob(full);
}

async function dropMatching(pred: (job: PadSyncJob) => boolean): Promise<void> {
  const ids = memoryQueue.filter(pred).map((job) => job.id);
  for (const id of ids) await dropJob(id);
}

async function dropPadPayloadJobs(kind: PadKindSync, padId: string): Promise<void> {
  await dropMatching((job) => {
    if (kind === "whiteboard" && job.op === "putWhiteboard") return job.body.id === padId;
    if (kind === "annotate" && job.op === "putAnnotate") return job.body.id === padId;
    if (kind === "problem" && job.op === "putProblem") return job.body.id === padId;
    if (job.op === "putSnapshot") {
      return job.body.key === padId && kindOfSnap(job.body.kind) === kind;
    }
    return false;
  });
}

function padIsTrashed(kind: PadKindSync, padId: string): boolean {
  if (kind === "problem") return false;
  if (kind === "whiteboard") return listWhiteboardTrash().some((row) => row.id === padId);
  return listAnnotateTrash().some((row) => row.id === padId);
}

function padIsLive(kind: PadKindSync, padId: string): boolean {
  if (kind === "problem") return false;
  if (kind === "whiteboard") return listWhiteboardNotebooks().some((row) => row.id === padId);
  return listAnnotateDocs().some((row) => row.id === padId);
}

function isTrashOp(job: PadSyncJob): boolean {
  return job.op === "deletePad" || job.op === "restorePad";
}

function trashOpCount(): number {
  return memoryQueue.filter(isTrashOp).length;
}

function lruTrashVictim(keep: { kind: PadKindSync; padId: string }): { kind: PadKindSync; padId: string } | null {
  const rows: Array<{ kind: PadKindSync; padId: string; touch: number }> = [
    ...listWhiteboardTrash().map((entry) => ({
      kind: "whiteboard" as const,
      padId: entry.id,
      touch: entry.lastTouch ?? entry.deletedAt ?? 0,
    })),
    ...listAnnotateTrash().map((entry) => ({
      kind: "annotate" as const,
      padId: entry.id,
      touch: entry.lastTouch ?? entry.deletedAt ?? 0,
    })),
  ].filter((row) => !(row.kind === keep.kind && row.padId === keep.padId));
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.touch - b.touch);
  return rows[0] ?? null;
}

export class TrashQueueFullError extends Error {
  readonly code = "pad-trash-queue-full" as const;
  constructor() {
    super("Pending delete queue is full");
    this.name = "TrashQueueFullError";
  }
}

async function ensureTrashQueueRoom(keep: { kind: PadKindSync; padId: string }): Promise<void> {
  while (trashOpCount() >= PAD_TRASH_OP_QUEUE_CAP) {
    const victim = lruTrashVictim(keep);
    if (!victim) throw new TrashQueueFullError();
    await dropMatching(
      (job) =>
        (job.op === "deletePad" || job.op === "restorePad") &&
        job.kind === victim.kind &&
        job.padId === victim.padId,
    );
    if (victim.kind === "whiteboard") await deleteWhiteboardNotebook(victim.padId);
    else await deleteAnnotateDoc(victim.padId);
  }
}

function liveAckMatchesStore(kind: PadKindSync, padId: string): boolean {
  if (kind === "whiteboard") {
    const row = listWhiteboardNotebooks().find((entry) => entry.id === padId);
    return row != null && row.hubAckUpdatedAt === row.updatedAt;
  }
  const row = listAnnotateDocs().find((entry) => entry.id === padId);
  return row != null && row.hubAckUpdatedAt === row.updatedAt;
}

function isGoneStatus(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 410;
}

function errorJson(cause: unknown): unknown {
  if (cause instanceof ApiError && cause.json !== undefined) return cause.json;
  if (cause instanceof ApiError && cause.bodyText) {
    try {
      return JSON.parse(cause.bodyText) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

async function applyLivePutFailure(
  kind: PadKindSync,
  padId: string,
  cause: unknown,
): Promise<boolean> {
  if (isGoneStatus(cause)) {
    await dropPadPayloadJobs(kind, padId);
    if (kind === "problem") await deleteProblemBoard(padId).catch(() => {});
    emitPadHub({ kind, id: padId, op: "close" });
    return true;
  }
  if (!isConflict(cause)) return false;
  const body = errorJson(cause);
  if (kind === "whiteboard") {
    await applyHubWhiteboard(body, { emitReload: true });
  } else if (kind === "annotate") {
    await applyHubAnnotate(body, { emitReload: true });
  } else {
    await applyHubProblem(body, { emitReload: true });
  }
  await dropPadPayloadJobs(kind, padId);
  return true;
}

async function applyHubWhiteboard(
  raw: unknown,
  opts: { emitReload: boolean },
): Promise<boolean> {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as WhiteboardPadDto;
  if (typeof row.id !== "string" || !row.board) return false;
  const local = await getWhiteboardNotebook(row.id);
  await restoreWhiteboardNotebook({
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    pageCount: row.page_count,
    board: row.board as BoardBlob,
    agent: Array.isArray(row.agent) ? row.agent : [],
    syncSeq: row.sync_seq,
    hubAckUpdatedAt: row.updated_at,
    ...(local?.locked ? { locked: true } : {}),
  });
  markWhiteboardHubAck(row.id, row.updated_at);
  if (opts.emitReload) emitPadHub({ kind: "whiteboard", id: row.id, op: "reload" });
  return true;
}

async function applyHubAnnotate(
  raw: unknown,
  opts: { emitReload: boolean },
): Promise<boolean> {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as AnnotatePadDto;
  if (typeof row.id !== "string" || !row.board) return false;
  const local = await getAnnotateDoc(row.id);
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
    syncSeq: row.sync_seq,
    hubAckUpdatedAt: row.updated_at,
    ...(local?.locked ? { locked: true } : {}),
  });
  markAnnotateHubAck(row.id, row.updated_at);
  if (opts.emitReload) emitPadHub({ kind: "annotate", id: row.id, op: "reload" });
  return true;
}

async function applyHubProblem(
  raw: unknown,
  opts: { emitReload: boolean },
): Promise<boolean> {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as ProblemPadDto;
  if (typeof row.id !== "string" || !row.board) return false;
  await putProblemBoard({
    id: row.id,
    dataset: row.dataset,
    taskId: row.task_id,
    updatedAt: row.updated_at,
    syncSeq: row.sync_seq,
    hubAckUpdatedAt: row.updated_at,
    board: row.board as BoardBlob,
    agent: Array.isArray(row.agent) ? row.agent : [],
  });
  markProblemHubAck(row.id, row.updated_at);
  if (opts.emitReload) emitPadHub({ kind: "problem", id: row.id, op: "reload" });
  return true;
}

export async function pushWhiteboardPad(
  client: LcClient,
  notebook: WhiteboardNotebook,
): Promise<boolean> {
  const body: WhiteboardPadDto = {
    id: notebook.id,
    title: notebook.title,
    updated_at: notebook.updatedAt,
    page_count: notebook.pageCount,
    sync_seq: notebook.syncSeq ?? 0,
    base_updated_at: notebook.hubAckUpdatedAt ?? 0,
    board: notebook.board,
    agent: notebook.agent ?? [],
  };
  try {
    const written = await client.putWhiteboardPad(notebook.id, body);
    markWhiteboardHubAck(notebook.id, written.updated_at ?? notebook.updatedAt);
    return true;
  } catch (cause) {
    if (await applyLivePutFailure("whiteboard", notebook.id, cause)) return false;
    await enqueuePadSync({ op: "putWhiteboard", body });
    return false;
  }
}

export async function pushAnnotatePad(client: LcClient, doc: AnnotateDoc): Promise<boolean> {
  const body: AnnotatePadDto = {
    id: doc.id,
    name: doc.name,
    hash: doc.hash,
    doc_type: doc.docType,
    updated_at: doc.updatedAt,
    sync_seq: doc.syncSeq ?? 0,
    base_updated_at: doc.hubAckUpdatedAt ?? 0,
    source: doc.source,
    footnotes: doc.footnotes ?? [],
    board: doc.board,
    agent: doc.agent ?? [],
  };
  try {
    const written = await client.putAnnotatePad(doc.id, body);
    markAnnotateHubAck(doc.id, written.updated_at ?? doc.updatedAt);
    return true;
  } catch (cause) {
    if (await applyLivePutFailure("annotate", doc.id, cause)) return false;
    await enqueuePadSync({ op: "putAnnotate", body });
    return false;
  }
}

export async function pushProblemPad(
  client: LcClient,
  row: ProblemBoardRecord,
): Promise<boolean> {
  const body: ProblemPadDto = {
    id: row.id,
    dataset: row.dataset,
    task_id: row.taskId,
    updated_at: row.updatedAt,
    sync_seq: row.syncSeq ?? 0,
    base_updated_at: row.hubAckUpdatedAt ?? 0,
    board: row.board,
    agent: row.agent ?? [],
  };
  try {
    const written = await client.putProblemPad(row.dataset, row.taskId, body);
    markProblemHubAck(row.id, written.updated_at ?? row.updatedAt);
    return true;
  } catch (cause) {
    if (await applyLivePutFailure("problem", row.id, cause)) return false;
    await enqueuePadSync({ op: "putProblem", body });
    return false;
  }
}

export async function pushRolledSnapshots(
  client: LcClient,
  written: PadSnapshot[],
): Promise<void> {
  for (const snap of written) {
    if (snap.tier === "2h") continue;
    if (padIsTrashed(kindOfSnap(snap.kind), snap.key)) continue;
    if (!liveAckMatchesStore(kindOfSnap(snap.kind), snap.key)) continue;
    await pushPadSnapshot(client, snap);
  }
}

export async function pushRecentSnapshots(
  client: LcClient,
  kind: PadSnapshotKind,
  key: string,
): Promise<void> {
  if (padIsTrashed(kindOfSnap(kind), key)) return;
  const { listPadSnapshots, getPadSnapshot } = await import("./padSnapshotStore");
  const metas = await listPadSnapshots(kind, key);
  for (const meta of metas) {
    if (meta.tier === "2h") continue;
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
      ...(snap.ink && snap.ink.length > 0 ? { ink: snap.ink } : {}),
      ...(snap.edges && snap.edges.length > 0 ? { edges: snap.edges } : {}),
      ...(typeof snap.source === "string" ? { source: snap.source } : {}),
    },
  };
  try {
    await client.putPadSnapshot(body);
    if (snap.tier === "24h" || snap.tier === "7d") {
      await compactLivePuts(kindOfSnap(snap.kind), snap.key, snap.writtenAt);
    }
  } catch {
    await enqueuePadSync({ op: "putSnapshot", body });
  }
}

function kindOfSnap(kind: string): PadSnapshotKind {
  return kind === "annotate" ? "annotate" : "whiteboard";
}

async function compactLivePuts(kind: PadKindSync, padId: string, until: number): Promise<void> {
  const ids = memoryQueue
    .filter((job) => {
      if (kind === "whiteboard" && job.op === "putWhiteboard") {
        return job.body.id === padId && job.body.updated_at <= until;
      }
      if (kind === "annotate" && job.op === "putAnnotate") {
        return job.body.id === padId && job.body.updated_at <= until;
      }
      return false;
    })
    .map((job) => job.id);
  for (const id of ids) await dropJob(id);
}

/**
 * Hashes the hub had nothing for, this session.
 *
 * A document whose bytes are missing locally *and* absent from the hub cannot
 * resolve until someone picks the file again. Without this the ping asks for it
 * once per row per ping, forever — and each of those is a round trip that fails
 * slowly when the hub is unreachable. Session-scoped on purpose: a restart, or
 * pushing the file from the other device, gets a fresh try.
 */
const missingRemoteBytes = new Set<string>();

export function resetMissingRemoteBytesForTests(): void {
  missingRemoteBytes.clear();
}

/**
 * Fetch a document's bytes from the hub, if that is even worth trying.
 *
 * Returns silently when there is no hub configured: the whole point of the
 * local copy is that a device with no sync still opens its own files, and
 * asking a server that does not exist is pure latency on a path a reader is
 * waiting behind.
 */
async function pullDocBytesFromHub(client: LcClient, hash: string): Promise<void> {
  if (!loadPadHub() || missingRemoteBytes.has(hash)) return;
  // Skip while the camera is moving — a later ping retries.
  if (isCameraBusy()) return;
  await yieldToIdle();
  if (isCameraBusy()) return;
  const bytes = await client.getDocBytes(hash).catch(() => null);
  if (!bytes || bytes.byteLength === 0) {
    missingRemoteBytes.add(hash);
    return;
  }
  // Length only here. A full rehash of the body belongs off the scroll path.
  if (!bytesMatchDocHash(hash, bytes)) {
    missingRemoteBytes.add(hash);
    return;
  }
  await yieldToIdle();
  if (isCameraBusy()) return;
  await putDocBytes(hash, bytes).catch(() => {});
}

/**
 * Run a pad-sync ping after the board is up and the browser is idle.
 *
 * Open used to fire this in the same turn as first paint. Overlay gone + idle
 * keeps the first wheel off a disk/hub walk.
 */
export function scheduleIdlePadSyncPing(
  client: LcClient,
  opts?: { emit?: boolean },
): void {
  // Gate here, not at callers: one missed call site must not leak a kick.
  if (!loadHubAutosync()) return;
  if (idlePadSyncTimer) clearTimeout(idlePadSyncTimer);
  idlePadSyncTimer = setTimeout(() => {
    idlePadSyncTimer = 0;
    const kick = () => {
      // Skip. The 15s tick retries. Do not poll every 200ms while flicking.
      if (isCameraBusy()) return;
      if (hubBackoffActive()) return;
      void applyPadSyncPing(client, opts).catch(() => {});
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => kick(), { timeout: 2500 });
    } else {
      kick();
    }
  }, padSyncIdleKickMs());
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
  kind: PadKindSync,
  padId: string,
  _localDelete?: () => Promise<void>,
): Promise<void> {
  if (kind === "problem") {
    await dropPadPayloadJobs(kind, padId);
    await sendDeletePad(client, kind, padId, 0);
    return;
  }
  await ensureTrashQueueRoom({ kind, padId });
  const seq =
    kind === "whiteboard"
      ? await trashWhiteboardNotebook(padId)
      : await trashAnnotateDoc(padId);
  if (seq == null) return;
  await dropPadPayloadJobs(kind, padId);
  await sendDeletePad(client, kind, padId, seq);
}

export async function restoreTrashedPad(
  client: LcClient,
  kind: PadKindSync,
  padId: string,
): Promise<void> {
  if (kind === "problem") return;
  await dropMatching(
    (job) => job.op === "deletePad" && job.kind === kind && job.padId === padId,
  );
  await dropPadPayloadJobs(kind, padId);
  await ensureTrashQueueRoom({ kind, padId });
  const restored =
    kind === "whiteboard"
      ? await restoreWhiteboardFromTrash(padId)
      : await restoreAnnotateFromTrash(padId);
  if (!restored) return;
  const seq = restored.syncSeq ?? 0;
  await enqueuePadSync({ op: "restorePad", kind, padId, seq });
  await flushPadSyncQueue(client);
}

async function sendDeletePad(
  client: LcClient,
  kind: PadKindSync,
  padId: string,
  seq: number,
): Promise<void> {
  await dropMatching(
    (job) => job.op === "deletePad" && job.kind === kind && job.padId === padId,
  );
  if (kind === "problem") {
    const parts = splitProblemPadId(padId);
    if (!parts) return;
    try {
      await client.tombstoneProblemPad(parts.dataset, parts.taskId, seq);
      await deleteProblemBoard(padId);
    } catch {
      await enqueuePadSync({ op: "deletePad", kind, padId, seq });
    }
    return;
  }
  await ensureTrashQueueRoom({ kind, padId });
  try {
    const ack =
      kind === "whiteboard"
        ? await client.tombstoneWhiteboardPad(padId, seq)
        : await client.tombstoneAnnotatePad(padId, seq);
    applyDeleteAck(kind, padId, ack);
  } catch {
    await enqueuePadSync({ op: "deletePad", kind, padId, seq });
  }
}

function applyDeleteAck(
  kind: PadKindSync,
  padId: string,
  ack: { applied?: boolean } | void,
): void {
  if (kind === "problem") return;
  if (!ack || typeof ack !== "object") {
    if (kind === "whiteboard") markWhiteboardDeleteAcked(padId, true);
    else markAnnotateDeleteAcked(padId, true);
    return;
  }
  if (ack.applied) {
    if (kind === "whiteboard") markWhiteboardDeleteAcked(padId, true);
    else markAnnotateDeleteAcked(padId, true);
  }
}

export async function tombstonePad(
  client: LcClient,
  kind: PadKindSync,
  padId: string,
  seq = 0,
): Promise<void> {
  await sendDeletePad(client, kind, padId, seq);
}

export async function restoreArchivedPad(
  client: LcClient,
  kind: PadKindSync,
  padId: string,
): Promise<void> {
  await restoreTrashedPad(client, kind, padId);
}

export async function flushPadSyncQueue(client: LcClient): Promise<void> {
  const jobs = [...memoryQueue];
  for (const job of jobs) {
    try {
      if (job.op === "putWhiteboard") {
        const written = await client.putWhiteboardPad(job.body.id, job.body);
        markWhiteboardHubAck(job.body.id, written.updated_at ?? job.body.updated_at);
      } else if (job.op === "putAnnotate") {
        const written = await client.putAnnotatePad(job.body.id, job.body);
        markAnnotateHubAck(job.body.id, written.updated_at ?? job.body.updated_at);
      } else if (job.op === "putProblem") {
        const written = await client.putProblemPad(job.body.dataset, job.body.task_id, job.body);
        markProblemHubAck(job.body.id, written.updated_at ?? job.body.updated_at);
      } else if (job.op === "putSnapshot") {
        if (!liveAckMatchesStore(kindOfSnap(job.body.kind), job.body.key)) {
          await dropJob(job.id);
          continue;
        }
        await client.putPadSnapshot(job.body);
        if (job.body.tier === "24h" || job.body.tier === "7d") {
          await compactLivePuts(kindOfSnap(job.body.kind), job.body.key, job.body.written_at);
        }
      } else if (job.op === "putBytes") await client.putDocBytes(job.hash, job.bytes);
      else if (job.op === "deletePad") {
        await dropPadPayloadJobs(job.kind, job.padId);
        if (job.kind === "problem") {
          const parts = splitProblemPadId(job.padId);
          if (parts) {
            await client.tombstoneProblemPad(parts.dataset, parts.taskId, job.seq);
            await deleteProblemBoard(job.padId);
          }
        } else {
          const ack =
            job.kind === "whiteboard"
              ? await client.tombstoneWhiteboardPad(job.padId, job.seq)
              : await client.tombstoneAnnotatePad(job.padId, job.seq);
          applyDeleteAck(job.kind, job.padId, ack);
        }
      } else if (job.op === "restorePad") {
        await pushRestoreAllFour(client, job.kind, job.padId, job.seq);
      }
      await dropJob(job.id);
    } catch (cause) {
      if (job.op === "putWhiteboard") {
        if (await applyLivePutFailure("whiteboard", job.body.id, cause)) {
          await dropJob(job.id);
          continue;
        }
      } else if (job.op === "putAnnotate") {
        if (await applyLivePutFailure("annotate", job.body.id, cause)) {
          await dropJob(job.id);
          continue;
        }
      } else if (job.op === "putProblem") {
        if (await applyLivePutFailure("problem", job.body.id, cause)) {
          await dropJob(job.id);
          continue;
        }
      }
      if (isConflict(cause)) {
        await dropJob(job.id);
        continue;
      }
      return;
    }
  }
}

async function pushRestoreAllFour(
  client: LcClient,
  kind: PadKindSync,
  padId: string,
  seq: number,
): Promise<void> {
  if (kind === "problem") return;
  if (kind === "whiteboard") {
    const notebook = await getWhiteboardNotebook(padId);
    if (!notebook) return;
    await client.putWhiteboardPad(padId, {
      id: notebook.id,
      title: notebook.title,
      updated_at: notebook.updatedAt,
      page_count: notebook.pageCount,
      sync_seq: seq,
      board: notebook.board,
      agent: notebook.agent ?? [],
    });
  } else {
    const doc = await getAnnotateDoc(padId);
    if (!doc) return;
    await client.putAnnotatePad(padId, {
      id: doc.id,
      name: doc.name,
      hash: doc.hash,
      doc_type: doc.docType,
      updated_at: doc.updatedAt,
      sync_seq: seq,
      source: doc.source,
      footnotes: doc.footnotes ?? [],
      board: doc.board,
      agent: doc.agent ?? [],
    });
  }
  for (const tier of PAD_SNAPSHOT_TIERS) {
    const row = await getPadSnapshot(kind, padId, tier.id);
    if (row) await client.putPadSnapshot({
      kind: row.kind,
      key: row.key,
      tier: row.tier,
      written_at: row.writtenAt,
      payload: {
        name: row.name,
        board: row.board,
        footnotes: row.footnotes,
        agent: row.agent,
        pageCount: row.pageCount,
      },
    });
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
  const [whiteboards, annotate] = await Promise.all([
    client.listWhiteboardPads(),
    client.listAnnotatePads(),
  ]);

  const trashedWb = new Set(listWhiteboardTrash().map((row) => row.id));
  for (const row of whiteboards) {
    if (isCameraBusy()) return;
    if (trashedWb.has(row.id)) continue;
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

  const trashedAn = new Set(listAnnotateTrash().map((row) => row.id));
  for (const row of annotate) {
    if (isCameraBusy()) return;
    if (trashedAn.has(row.id)) continue;
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
      if (!have) await pullDocBytesFromHub(client, row.hash);
    }
  }

  for (const row of whiteboards) {
    if (isCameraBusy()) return;
    await fillMissingSnapshots(client, "whiteboard", row.id);
  }
  /*
   * Annotate snapshots are keyed by the sidecar id, like whiteboard's.
   *
   * They used to be keyed by the annotated file's hash, which meant two
   * annotation sets on one PDF would have shared all three tiers. Snapshots
   * the daemon still holds under a hash are simply not pulled — they belong to
   * a key nothing asks for any more.
   *
   * The old wording here said the live pad rows carry the ink. They have not
   * since live saves moved to `STORE_INK_PAGES`, and nothing carried it at all
   * until `inkSync` — which is the hole §2c exists to close.
   */
  for (const row of annotate) {
    if (isCameraBusy()) return;
    await fillMissingSnapshots(client, "annotate", row.id);
  }
  if (isCameraBusy()) return;
  const seenHash = new Set<string>();
  for (const row of annotate) {
    if (!row.hash || seenHash.has(row.hash)) continue;
    seenHash.add(row.hash);
  }
  await syncDocChunks(client, [...seenHash]).catch(() => {});
}

/**
 * Periodic ping: apply every saved file that changed after `since`.
 *
 * Whiteboards, annotated documents (plus PDF/EPUB bytes), and rolling
 * snapshots. Newer remote wins. A local padlock blocks tombstones only.
 */
export async function applyPadSyncPing(
  client: LcClient,
  opts?: { emit?: boolean },
): Promise<void> {
  // Same gate as the idle kick; checked before the in-flight latch so an Off
  // switch wins even when a ping is already mid-flight.
  if (!loadHubAutosync()) return;
  if (isCameraBusy()) return;
  if (hubBackoffActive()) return;
  if (padSyncPingInFlight) return;
  padSyncPingInFlight = true;
  try {
    await applyPadSyncPingBody(client, opts);
  } finally {
    padSyncPingInFlight = false;
  }
}

async function applyPadSyncPingBody(
  client: LcClient,
  opts?: { emit?: boolean },
): Promise<void> {
  const emit = opts?.emit !== false;
  const since = loadPadSyncSince();
  let ping;
  try {
    ping = await client.pingPadSync(since);
    noteHubPingOk();
  } catch (cause) {
    noteHubPingFail();
    throw cause;
  }
  const pendingDelete = new Set(
    memoryQueue
      .filter((job) => job.op === "deletePad")
      .map((job) => `${job.kind}:${job.padId}`),
  );
  const trashWb = new Set(listWhiteboardTrash().map((row) => row.id));
  const trashAn = new Set(listAnnotateTrash().map((row) => row.id));

  for (const gone of ping.gone ?? []) {
    if (isCameraBusy()) return;
    const kind: PadKindSync =
      gone.kind === "annotate" ? "annotate" : gone.kind === "problem" ? "problem" : "whiteboard";
    await dropPadPayloadJobs(kind, gone.id);
    if (emit) emitPadHub({ kind, id: gone.id, op: "close" });
    if (gone.kind === "whiteboard") {
      if (listWhiteboardNotebooks().find((entry) => entry.id === gone.id)?.locked) continue;
      if (trashWb.has(gone.id)) {
        markWhiteboardDeleteAcked(gone.id, true);
        continue;
      }
      await deleteWhiteboardNotebook(gone.id).catch(() => {});
    } else if (gone.kind === "annotate") {
      if (listAnnotateDocs().find((entry) => entry.id === gone.id)?.locked) continue;
      if (trashAn.has(gone.id)) {
        markAnnotateDeleteAcked(gone.id, true);
        continue;
      }
      await deleteAnnotateDoc(gone.id).catch(() => {});
    } else if (gone.kind === "problem") {
      await deleteProblemBoard(gone.id).catch(() => {});
    }
  }

  for (const row of ping.whiteboard) {
    if (isCameraBusy()) return;
    if (trashWb.has(row.id) || pendingDelete.has(`whiteboard:${row.id}`)) continue;
    const local = await getWhiteboardNotebook(row.id);
    if (local?.locked && local.deletedAt) continue;
    const stale =
      !local ||
      boardLooksCorrupt(local.board) ||
      row.updated_at > local.updatedAt;
    if (!stale) {
      markWhiteboardHubAck(row.id, row.updated_at);
      continue;
    }
    await dropPadPayloadJobs("whiteboard", row.id);
    await applyHubWhiteboard(row, { emitReload: emit });
  }

  for (const row of ping.annotate) {
    if (isCameraBusy()) return;
    if (trashAn.has(row.id) || pendingDelete.has(`annotate:${row.id}`)) continue;
    const local = await getAnnotateDoc(row.id);
    const stale =
      !local ||
      boardLooksCorrupt(local.board) ||
      row.updated_at > local.updatedAt;
    if (!stale) {
      markAnnotateHubAck(row.id, row.updated_at);
      continue;
    }
    await dropPadPayloadJobs("annotate", row.id);
    await applyHubAnnotate(row, { emitReload: emit });
    if (row.hash) {
      const have = await getDocBytes(row.hash);
      if (!have) await pullDocBytesFromHub(client, row.hash);
    }
  }

  {
    if (isCameraBusy()) return;
    const hashes = new Set<string>();
    for (const row of listAnnotateDocs()) {
      if (row.hash) hashes.add(row.hash);
    }
    for (const row of ping.annotate) {
      if (row.hash) hashes.add(row.hash);
    }
    await syncDocChunks(client, [...hashes]).catch(() => {});
  }

  /*
   * Handwriting and edges — the two rows that were authored and unsynced.
   *
   * On the same ping, and off the same watermark: the digest of what changed
   * arrives with everything else, so a quiet interval costs no extra request
   * and moves no strokes. Only pads the digest actually names, plus the ones
   * this device holds, are examined.
   */
  {
    if (isCameraBusy()) return;
    const pads: Array<{ kind: InkPadKind; key: string }> = [
      ...listWhiteboardNotebooks().map((row) => ({ kind: "whiteboard" as const, key: row.id })),
      ...listAnnotateDocs().map((row) => ({ kind: "annotate" as const, key: row.id })),
    ];
    const conflicts = await syncInkPages(client, ping.ink ?? [], pads, since).catch(() => []);
    if (conflicts.length > 0) noteInkConflicts(conflicts);
    await syncEdges(client, ping.edges ?? [], ping.gone_edges ?? []).catch(() => {});
  }

  for (const row of ping.problem ?? []) {
    if (isCameraBusy()) return;
    if (pendingDelete.has(`problem:${row.id}`)) continue;
    const local = await getProblemBoard(row.id);
    const stale =
      !local ||
      boardLooksCorrupt(local.board) ||
      row.updated_at > local.updatedAt;
    if (!stale) {
      markProblemHubAck(row.id, row.updated_at);
      continue;
    }
    await dropPadPayloadJobs("problem", row.id);
    await applyHubProblem(row, { emitReload: emit });
  }

  for (const row of ping.snapshots) {
    if (isCameraBusy()) return;
    const kind = kindOfSnap(row.kind);
    if (row.tier === "2h") {
      if (!padIsLive(kind, row.key) || padIsTrashed(kind, row.key)) continue;
      const local = await getPadSnapshot(kind, row.key, "2h");
      if (local) continue;
    }
    await writeSnapshotIfNewer(row);
  }

  savePadSyncSince(ping.now);
}

export async function sweepPadTrash(now = Date.now()): Promise<void> {
  const { sweepWhiteboardTrash } = await import("./whiteboardStore");
  const { sweepAnnotateTrash } = await import("./annotateStore");
  await sweepWhiteboardTrash(now);
  await sweepAnnotateTrash(now);
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
  for (const row of remote) {
    if (row.tier === "2h" && !padIsLive(kind, key)) continue;
    await writeSnapshotIfNewer(row, { skipIfLocal: true });
  }
}

async function writeSnapshotIfNewer(
  row: PadSnapshotDto,
  opts?: { skipIfLocal?: boolean },
): Promise<void> {
  const kind = row.kind as PadSnapshotKind;
  if (kind !== "whiteboard" && kind !== "annotate") return;
  const key = row.key;
  const tier = row.tier as PadSnapshot["tier"];
  if (!PAD_SNAPSHOT_TIERS.some((entry) => entry.id === tier)) return;
  const local = await getPadSnapshot(kind, key, tier);
  if (opts?.skipIfLocal && local) return;
  if (local && local.writtenAt >= row.written_at) return;
  const payload = (row.payload ?? {}) as Partial<PadSnapshot> & {
    ink?: unknown;
    edges?: unknown;
    source?: unknown;
  };
  const snap: PadSnapshot = {
    kind,
    key,
    tier,
    writtenAt: row.written_at,
    name: payload.name ?? key,
    board: payload.board as BoardBlob,
    footnotes: payload.footnotes,
    agent: payload.agent,
    pageCount: payload.pageCount,
    ...(Array.isArray(payload.ink) ? { ink: payload.ink as PadSnapshot["ink"] } : {}),
    ...(Array.isArray(payload.edges) ? { edges: payload.edges as PadSnapshot["edges"] } : {}),
    ...(typeof payload.source === "string" ? { source: payload.source } : {}),
  };
  try {
    const { run: idbRun, STORE_SNAPSHOTS } = await import("./idb");
    await idbRun(STORE_SNAPSHOTS, "readwrite", (store) =>
      store.put(snap, `${kind}:${key}:${row.tier}`),
    );
  } catch {
    /* ignore */
  }
}

export { PAD_SNAPSHOT_TIERS };
