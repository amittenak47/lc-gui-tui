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
import { putPadRecord } from "./padRecordUpload";
import { recordAuthoredExtras } from "./recordAuthoredExtras";
import { resetPadWritersForTests, withPadWriter } from "./padWriter";
import { mergeAgentMessages } from "../modes/coachSessions";
import { putParentContent } from "./contentStore";
import type { BoardBlob } from "../canvas/BoardHandle";
import { artifactCatalogFields } from "./padArtifacts";
import { downloadArtifactAssets } from "./artifactAssetSync";
import { clearProblemArtifactConflict, stashProblemArtifactConflict } from "./problemArtifactConflict";
import { parseArtifactSnapshotBundle, stageArtifactSnapshot } from "./artifactSnapshot";
import {
  deleteAnnotateDoc,
  getAnnotateDoc,
  listAnnotateDocs,
  localFootnoteBoardIds,
  listAnnotateTrash,
  markAnnotateDeleteAcked,
  restoreAnnotateDoc,
  restoreAnnotateFromTrash,
  trashAnnotateDoc,
  markAnnotateHubAck,
  annotateDocLabel,
  type AnnotateDoc,
  type DocType,
} from "./annotateStore";
import { isAndroidDevice } from "./androidDevice";
import { isCameraBusy, yieldToIdle } from "./cameraBusy";
import { bytesMatchDocHash, getDocBytes, putDocBytes } from "./docBytes";
import type { DocFootnote } from "./docFootnotes";
import {
  applyFootnoteBoards,
  collectFootnoteBoards,
} from "./footnoteWhiteboardStore";
import { run, STORE_SYNC_STATE } from "./idb";
import { getBookSyncState, type SyncState } from "./syncState";
import { mutateLocalBook } from "./localBookStore";
import {
  HUB_MAX_BODY_BYTES,
  HUB_MAX_DOCUMENT_BYTES,
  loadPadHub,
  loadPadSyncSince,
  savePadSyncSince,
} from "./padHub";
import { loadHubAutosync } from "./hubAutoSyncPref";
import { isPadHubOffline, subscribePadHubStatus } from "./padHubStatus";
import { syncDocChunks } from "./docChunkSync";
import { noteInkConflicts } from "./inkConflicts";
import {
  footnoteInkKeys,
  footnoteInkHubKey,
  pullInkPagesOverLocal,
  syncEdges,
  syncInkPages,
  type InkPadKind,
} from "./inkSync";
import {
  getPadSnapshot,
  PAD_SNAPSHOT_TIERS,
  type PadSnapshot,
  type PadSnapshotKind,
} from "./padSnapshotStore";
import {
  acceptProblemHubAgent,
  deleteProblemBoard,
  getProblemBoard,
  markProblemHubAck,
  putProblemBoard,
  replaceProblemBoard,
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

let hubBodyCapOverride: number | null = null;

export function setPadSyncBodyCapForTests(bytes: number | null): void {
  hubBodyCapOverride = bytes;
}

function hubBodyCap(): number {
  return hubBodyCapOverride ?? HUB_MAX_BODY_BYTES;
}

export function hubBodyBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}

export function exceedsHubBodyCap(
  body: unknown,
  cap: number = hubBodyCap(),
): boolean {
  return hubBodyBytes(body) > cap;
}

export function resetPadSyncForTests(): void {
  resetPadWritersForTests(); pendingPadPushes.clear();
  hubBackoffUntil = 0; hubBackoffMs = HUB_BACKOFF_MIN_MS; hubBodyCapOverride = null;
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

async function applyLivePutFailure(kind: PadKindSync, padId: string, cause: unknown): Promise<boolean> {
  if (isGoneStatus(cause)) {
    console.warn(`${kind} ${padId} was deleted on another device. The local copy is kept.`);
    return true;
  }
  if (!isConflict(cause)) return false;
  // A failed explicit transfer has no consent to replace a local alternative.
  if (kind === "problem") {
    const remote = errorJson(cause); const local = await getProblemBoard(padId);
    if (local && remote && typeof remote === "object" && (local.artifacts || "artifacts" in remote)) stashProblemArtifactConflict(local, remote as ProblemPadDto);
  }
  return true;
}

/*
 * Exported for the Sync walk's conflict resolver: "take the server" writes
 * the stashed hub row straight into IDB, exactly as a ping apply would have.
 */
export async function applyHubWhiteboard(
  raw: unknown,
  opts: { emitReload: boolean; client?: LcClient },
): Promise<boolean> {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as WhiteboardPadDto;
  if (typeof row.id !== "string" || !row.board) return false;
  const artifactFields = artifactCatalogFields(row.artifacts, { kind: "whiteboard", id: row.id });
  const local = await getWhiteboardNotebook(row.id);
  await downloadArtifactAssets(opts.client, artifactFields.artifacts);
  if (artifactFields.artifacts) {
    const after = await getWhiteboardNotebook(row.id);
    if (after?.updatedAt !== local?.updatedAt || after?.syncSeq !== local?.syncSeq || after?.deletedAt !== local?.deletedAt) {
      throw new Error("The notebook changed during attachment download. Local work was kept; retry sync.");
    }
  }
  await restoreWhiteboardNotebook({
    ...artifactFields,
    authoredExtras: recordAuthoredExtras(raw),
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    pageCount: row.page_count,
    board: row.board as BoardBlob,
    agent: mergeAgentMessages(local?.agent ?? [], Array.isArray(row.agent) ? row.agent : []),
    syncSeq: row.sync_seq,
    hubAckUpdatedAt: row.updated_at,
    ...(local?.locked ? { locked: true } : {}),
  });
  await markWhiteboardHubAck(row.id, row.updated_at);
  if (opts.emitReload) emitPadHub({ kind: "whiteboard", id: row.id, op: "reload" });
  return true;
}

export async function applyHubAnnotate(
  raw: unknown,
  opts: { emitReload: boolean; client?: LcClient },
): Promise<boolean> {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as AnnotatePadDto;
  if (typeof row.id !== "string" || !row.board) return false;
  const artifactFields = artifactCatalogFields(row.artifacts, { kind: "annotate", id: row.id });
  const local = await getAnnotateDoc(row.id);
  await downloadArtifactAssets(opts.client, artifactFields.artifacts);
  if (artifactFields.artifacts) {
    const after = await getAnnotateDoc(row.id);
    if (after?.updatedAt !== local?.updatedAt || after?.syncSeq !== local?.syncSeq || after?.deletedAt !== local?.deletedAt) {
      throw new Error("The document changed during attachment download. Local work was kept; retry sync.");
    }
  }
  await restoreAnnotateDoc({
    ...artifactFields,
    authoredExtras: recordAuthoredExtras(raw),
    id: row.id,
    name: row.name,
    hash: row.hash,
    docType: (row.doc_type as DocType) || "markdown",
    updatedAt: row.updated_at,
    source: row.source ?? "",
    board: row.board as BoardBlob,
    footnotes: Array.isArray(row.footnotes) ? (row.footnotes as DocFootnote[]) : [],
    agent: mergeAgentMessages(local?.agent ?? [], Array.isArray(row.agent) ? row.agent : []),
    syncSeq: row.sync_seq,
    hubAckUpdatedAt: row.updated_at,
    ...(typeof row.label === "string" && row.label.trim()
      ? { label: row.label.trim() }
      : local?.label
        ? { label: local.label }
        : {}),
    ...(local?.locked ? { locked: true } : {}),
    ...(local?.owned ? { owned: true } : {}),
  });
  await markAnnotateHubAck(row.id, row.updated_at);
  if (row.footnote_boards && typeof row.footnote_boards === "object") {
    await applyFootnoteBoards(
      row.id,
      row.footnote_boards as Record<string, { board: BoardBlob; pageCount: number }>,
    );
  }
  if (opts.emitReload) emitPadHub({ kind: "annotate", id: row.id, op: "reload" });
  return true;
}

export async function applyHubProblem(
  raw: unknown,
  opts: { emitReload: boolean; client?: LcClient },
): Promise<boolean> {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as ProblemPadDto;
  if (typeof row.id !== "string" || !row.board) return false;
  const before = await getProblemBoard(row.id);
  const artifactFields = artifactCatalogFields(row.artifacts, { kind: "problem", id: row.id });
  if (artifactFields.artifacts) {
    await downloadArtifactAssets(opts.client, artifactFields.artifacts);
    const after = await getProblemBoard(row.id);
    if (after?.updatedAt !== before?.updatedAt || after?.syncSeq !== before?.syncSeq) {
      throw new Error("The problem board changed during attachment download. Local work was kept; retry sync.");
    }
  }
  const replacement: ProblemBoardRecord = {
    ...artifactFields,
    authoredExtras: recordAuthoredExtras(raw),
    id: row.id,
    dataset: row.dataset,
    taskId: row.task_id,
    updatedAt: row.updated_at,
    syncSeq: row.sync_seq,
    hubAckUpdatedAt: row.updated_at,
    board: row.board as BoardBlob,
    agent: mergeAgentMessages(before?.agent ?? [], Array.isArray(row.agent) ? row.agent : []),
  };
  if (before?.artifacts || artifactFields.artifacts) await replaceProblemBoard(before, replacement);
  else await putProblemBoard(replacement);
  await markProblemHubAck(row.id, row.updated_at);
  if (opts.emitReload) emitPadHub({ kind: "problem", id: row.id, op: "reload" });
  return true;
}

const pendingPadPushes = new Map<string, Set<Promise<boolean>>>();

function trackPadPush(kind: string, id: string, job: Promise<boolean>): Promise<boolean> {
  const key = `${kind}:${id}`;
  const pending = pendingPadPushes.get(key) ?? new Set<Promise<boolean>>();
  pending.add(job);
  pendingPadPushes.set(key, pending);
  const release = () => {
    pending.delete(job);
    if (pending.size === 0) pendingPadPushes.delete(key);
  };
  void job.then(release, release);
  return job;
}

/** First Save may still be uploading when Sync is tapped. Read its ack afterwards. */
export async function waitForPadPushes(kind: string, id: string): Promise<void> {
  if (isPadHubOffline()) return;
  const key = `${kind}:${id}`;
  while (pendingPadPushes.get(key)?.size) {
    let stop = () => {};
    const offline = new Promise<void>((resolve) => {
      stop = subscribePadHubStatus(() => { if (isPadHubOffline()) resolve(); });
    });
    try {
      await Promise.race([Promise.all([...pendingPadPushes.get(key)!]), offline]);
    } finally { stop(); }
    if (isPadHubOffline()) return;
  }
}

/** Apply the hub's transcript union without replacing a live board or saved baseline. */
export async function acceptHubAgent(kind: "annotate" | "whiteboard", id: string, agent: unknown): Promise<void> {
  if (!Array.isArray(agent)) return;
  await putParentContent({ kind, id }, { artifacts: undefined, agent }, { agentOnly: true, authored: false });
}

/** All successful record writers acknowledge the returned hub clock here. */
export async function markHubAck(
  kind: PadKindSync, id: string, updatedAt: number,
  liveAck?: (updatedAt: number) => void | Promise<void>,
): Promise<void> {
  if (liveAck) await liveAck(updatedAt);
  else if (kind === "whiteboard") await markWhiteboardHubAck(id, updatedAt);
  else if (kind === "annotate") await markAnnotateHubAck(id, updatedAt);
  else await markProblemHubAck(id, updatedAt);
}

export function pushWhiteboardPad(client: LcClient, notebook: WhiteboardNotebook): Promise<boolean> {
  return trackPadPush("whiteboard", notebook.id, withPadWriter("whiteboard", notebook.id, async () => {
    const modern = await pushCurrentModernBook(client, "whiteboard", notebook.id);
    return modern === undefined ? pushWhiteboardPadNow(client, notebook) : modern;
  }));
}
/** Compatibility writers dispatch by capability before sending any live data. */
async function pushCurrentModernBook(client: LcClient, kind: PadKindSync, id: string): Promise<boolean | undefined> {
  if (!client.pingPadSync) return undefined; // Explicitly old isolated adapters.
  try {
    const { boundedBookRequest, syncBook } = await import("./bookSync");
    const { isModernBookHub } = await import("./bookSyncPass");
    const ping = await boundedBookRequest(() => client.pingPadSync(0, {}), new AbortController().signal);
    if (!isModernBookHub(ping)) return undefined;
    const result = await syncBook(client, kind, id);
    return result.status === "synced" || result.status === "unchanged";
  } catch { return false; }
}

async function pushWhiteboardPadNow(
  client: LcClient,
  notebook: WhiteboardNotebook,
): Promise<boolean> {
  const saved = await getWhiteboardNotebook(notebook.id);
  if (!saved || padIsTrashed("whiteboard", notebook.id)) return false;
  const body = whiteboardPadBody(saved);
  if (isPadHubOffline()) {
    return false;
  }
  try {
    const written = await putPadRecord(client, "whiteboard", body);
    await acceptHubAgent("whiteboard", notebook.id, written.agent);
    await markHubAck("whiteboard", notebook.id, written.updated_at ?? notebook.updatedAt);
    return true;
  } catch (cause) {
    if (await applyLivePutFailure("whiteboard", notebook.id, cause)) return false;
    return false;
  }
}

/** The wire form of a notebook; shared by autosave and the Sync walk. */
export function whiteboardPadBody(notebook: WhiteboardNotebook): WhiteboardPadDto {
  return {
    ...notebook.authoredExtras,
    ...artifactCatalogFields(notebook.artifacts, { kind: "whiteboard", id: notebook.id }),
    id: notebook.id,
    title: notebook.title,
    updated_at: notebook.updatedAt,
    page_count: notebook.pageCount,
    sync_seq: notebook.syncSeq ?? 0,
    base_updated_at: notebook.hubAckUpdatedAt ?? 0,
    board: notebook.board,
    agent: notebook.agent ?? [],
  };
}

/** The wire form of an annotate doc; shared by autosave and the Sync walk. */
export async function annotatePadBody(doc: AnnotateDoc): Promise<AnnotatePadDto> {
  return {
    ...doc.authoredExtras,
    ...artifactCatalogFields(doc.artifacts, { kind: "annotate", id: doc.id }),
    id: doc.id,
    name: doc.name,
    ...(doc.label?.trim() ? { label: doc.label.trim() } : {}),
    hash: doc.hash,
    doc_type: doc.docType,
    updated_at: doc.updatedAt,
    sync_seq: doc.syncSeq ?? 0,
    base_updated_at: doc.hubAckUpdatedAt ?? 0,
    source: doc.source,
    footnotes: doc.footnotes ?? [],
    board: doc.board,
    agent: doc.agent ?? [],
    /*
     * Structure, not strokes.
     *
     * Elements, page count and appState travel with the pad; the handwriting
     * on each scratch board rides `putInkPage` under `{padId}/fn/{wbId}` like
     * every other page of ink in the app. Sending both was the main way a
     * textbook pad reached the hub's 32 MB cap.
     */
    footnote_boards: await collectFootnoteBoards(doc.id, doc.footnotes ?? [], {
      slim: true,
      requireAll: true,
    }),
  };
}

export function pushAnnotatePad(client: LcClient, doc: AnnotateDoc): Promise<boolean> {
  return trackPadPush("annotate", doc.id, withPadWriter("annotate", doc.id, async () => {
    const modern = await pushCurrentModernBook(client, "annotate", doc.id);
    return modern === undefined ? pushAnnotatePadNow(client, doc) : modern;
  }));
}

async function pushAnnotatePadNow(client: LcClient, doc: AnnotateDoc): Promise<boolean> {
  const saved = await getAnnotateDoc(doc.id);
  if (!saved || padIsTrashed("annotate", doc.id)) return false;
  const body = await annotatePadBody(saved);
  if (exceedsHubBodyCap(body)) {
    throw new Error(
      `this pad is ${Math.round(hubBodyBytes(body) / (1024 * 1024))} MB, and the hub ` +
        `takes at most ${Math.round(hubBodyCap() / (1024 * 1024))} MB — ` +
        `it stays on this device`,
    );
  }
  if (isPadHubOffline()) {
    return false;
  }
  try {
    const written = await putPadRecord(client, "annotate", body);
    await acceptHubAgent("annotate", doc.id, written.agent);
    await markHubAck("annotate", doc.id, written.updated_at ?? doc.updatedAt);
    return true;
  } catch (cause) {
    if (await applyLivePutFailure("annotate", doc.id, cause)) return false;
    return false;
  }
}

export function pushProblemPad(client: LcClient, row: ProblemBoardRecord): Promise<boolean> {
  return trackPadPush("problem", row.id, withPadWriter("problem", row.id, async () => {
    const modern = await pushCurrentModernBook(client, "problem", row.id);
    return modern === undefined ? pushProblemPadNow(client, row.id) : modern;
  }));
}

async function pushProblemPadNow(client: LcClient, id: string): Promise<boolean> {
  const row = await getProblemBoard(id);
  if (!row || isPadHubOffline()) return false;
  const body: ProblemPadDto = {
    ...row.authoredExtras,
    ...artifactCatalogFields(row.artifacts, { kind: "problem", id: row.id }),
    id: row.id, dataset: row.dataset, task_id: row.taskId, updated_at: row.updatedAt,
    sync_seq: row.syncSeq ?? 0, base_updated_at: row.hubAckUpdatedAt ?? 0,
    board: row.board, agent: row.agent ?? [],
  };
  try {
    const written = await client.putProblemPad(row.dataset, row.taskId, body);
    const current = await getProblemBoard(id);
    if (current && current.updatedAt === row.updatedAt && current.artifacts?.revision === row.artifacts?.revision) {
      await acceptProblemHubAgent(id, written.agent);
      await markHubAck("problem", id, written.updated_at ?? row.updatedAt);
      clearProblemArtifactConflict(id);
    }
    return true;
  } catch (cause) {
    await applyLivePutFailure("problem", id, cause);
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
  const artifactBundle = parseArtifactSnapshotBundle(snap.artifactBundle, { kind: snap.kind, id: snap.key });
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
      ...(artifactBundle ? { artifactBundle } : {}),
      ...(snap.footnoteBoards ? { footnoteBoards: snap.footnoteBoards } : {}),
      ...(snap.footnoteInk ? { footnoteInk: snap.footnoteInk } : {}),
      ...(snap.ink && snap.ink.length > 0 ? { ink: snap.ink } : {}),
      ...(snap.edges && snap.edges.length > 0 ? { edges: snap.edges } : {}),
      ...(typeof snap.source === "string" ? { source: snap.source } : {}),
    },
  };
  if (isPadHubOffline()) throw new Error("Can't reach the hub. Snapshots are kept on this device.");
  await client.putPadSnapshot(body);
}

/** Retry retained current copies, including backups whose parent has been removed. */
export async function syncLegacySnapshots(client: LcClient): Promise<void> {
  const { listAllPadSnapshots } = await import("./padSnapshotStore");
  for (const meta of await listAllPadSnapshots()) {
    const snapshot = await getPadSnapshot(meta.kind, meta.key, meta.tier, meta.snapshotId);
    if (!snapshot) throw new Error(`${meta.name}: a retained snapshot could not be read. It was kept.`);
    await pushPadSnapshot(client, snapshot);
  }
}

function kindOfSnap(kind: string): PadSnapshotKind {
  return kind === "annotate" ? "annotate" : "whiteboard";
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
  if (!loadPadHub() || isPadHubOffline() || missingRemoteBytes.has(hash)) return;
  // Skip while the camera is moving — a later ping retries.
  if (isCameraBusy()) return;
  await yieldToIdle();
  if (isCameraBusy()) return;
  let bytes: ArrayBuffer | null;
  try { bytes = await client.getDocBytes(hash); }
  catch { return; } // Offline is not proof that the document is absent.
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
  _opts?: { emit?: boolean },
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
      void import("./bookSyncPass").then(({ syncBookPass }) => syncBookPass(client, { silent: true })).catch(() => {});
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => kick(), { timeout: 2500 });
    } else {
      kick();
    }
  }, padSyncIdleKickMs());
}

export async function pushDocBytes(client: LcClient, hash: string, bytes: ArrayBuffer): Promise<void> {
  /*
   * Refused here, not on the wire.
   *
   * The hub caps document files at {@link HUB_MAX_DOCUMENT_BYTES} and the picker
   * has no matching limit, so a large enough document could never upload — and
   * every attempt retained another full upload payload. Say
   * so once instead. The document is still open and still local; it is the
   * hub copy that is not happening.
   */
  if (loadPadHub() && bytes.byteLength > HUB_MAX_DOCUMENT_BYTES) {
    throw new Error(
      `this file is ${Math.round(bytes.byteLength / (1024 * 1024))} MiB, and the hub ` +
        `takes at most ${Math.round(HUB_MAX_DOCUMENT_BYTES / (1024 * 1024))} MiB — ` +
        `it stays on this device`,
    );
  }
  await putDocBytes(hash, bytes);
  if (isPadHubOffline()) return;
  await client.putDocBytes(hash, bytes).catch(() => {});
}

export async function deletePadEverywhere(
  client: LcClient,
  kind: PadKindSync,
  padId: string,
  _localDelete?: () => Promise<void>,
  options?: import("./bookSync").BookSyncOptions,
): Promise<void> {
  if (kind === "problem") {
    await deleteProblemBoard(padId);
    const state = await getBookSyncState(kind, padId);
    if (state?.lifecycle) await sendDeletePad(client, kind, padId, state.lifecycle.seq, options);
    return;
  }
  const seq =
    kind === "whiteboard"
      ? await trashWhiteboardNotebook(padId)
      : await trashAnnotateDoc(padId);
  if (seq == null) return;
  await sendDeletePad(client, kind, padId, seq, options);
}

export type RestoreTrashedPadResult =
  | { ok: true; title: string }
  | { ok: false };

export async function restoreTrashedPad(
  client: LcClient,
  kind: PadKindSync,
  padId: string,
  options?: import("./bookSync").BookSyncOptions,
): Promise<RestoreTrashedPadResult> {
  if (kind === "problem") return { ok: false };
  if (kind === "whiteboard") {
    const restored = await restoreWhiteboardFromTrash(padId);
    if (!restored) return { ok: false };
    const seq = restored.syncSeq ?? 0;
    if (!isPadHubOffline()) await pushRestoreAllFour(client, kind, padId, seq, options).catch(() => {});
    return { ok: true, title: restored.title };
  }
  const restored = await restoreAnnotateFromTrash(padId);
  if (!restored) return { ok: false };
  const seq = restored.syncSeq ?? 0;
  if (!isPadHubOffline()) await pushRestoreAllFour(client, kind, padId, seq, options).catch(() => {});
  return { ok: true, title: annotateDocLabel(restored) };
}

async function sendDeletePad(client: LcClient, kind: PadKindSync, padId: string, seq: number, options?: import("./bookSync").BookSyncOptions): Promise<void> {
  if (isPadHubOffline()) return;
  if (client.pingPadSync) {
    try {
      const { syncBookPass, isModernBookHub } = await import("./bookSyncPass");
      const { boundedBookRequest } = await import("./bookSync");
      const ping = await boundedBookRequest(() => client.pingPadSync(0, {}), new AbortController().signal);
      if (isModernBookHub(ping)) { await syncBookPass(client, { ...options, ping, selected: { kind, id: padId } }); return; }
    } catch { return; } // The current durable intent remains pending.
  }
  const captured = await getBookSyncState(kind, padId);
  try {
    const parts = kind === "problem" ? splitProblemPadId(padId) : null;
    const ack = kind === "whiteboard" ? await client.tombstoneWhiteboardPad(padId, seq) :
      kind === "annotate" ? await client.tombstoneAnnotatePad(padId, seq) :
      parts ? await client.tombstoneProblemPad(parts.dataset, parts.taskId, seq) : undefined;
    if (ack?.applied !== true) return;
    // A stale deletion reply cannot clear a newer restore/delete intent.
    if (!captured?.lifecycle) return;
    await mutateLocalBook({ kind, id: padId }, { authored: false, requireIdb: true }, ctx => {
      if (ctx.state.lifecycle?.token !== captured.lifecycle!.token) return;
      ctx.setState({ ...ctx.state, lifecycle: null });
      if (ctx.metadata) ctx.setMetadata({ ...ctx.metadata, deleteAcked: true });
    });
  } catch { /* The durable desired state remains eligible for explicit retry. */ }
}

export async function tombstonePad(client: LcClient, kind: PadKindSync, padId: string, seq = 0): Promise<void> {
  await mutateLocalBook({ kind, id: padId }, { requireIdb: true }, ctx => ctx.markLifecycle("delete", seq));
  await sendDeletePad(client, kind, padId, seq);
}

export async function restoreArchivedPad(
  client: LcClient,
  kind: PadKindSync,
  padId: string,
): Promise<void> {
  await restoreTrashedPad(client, kind, padId);
}

async function pushRestoreAllFour(
  client: LcClient,
  kind: PadKindSync,
  padId: string,
  seq: number,
  options?: import("./bookSync").BookSyncOptions,
): Promise<boolean> {
  if (client.pingPadSync) {
    try {
      const { syncBookPass, isModernBookHub } = await import("./bookSyncPass");
      const { boundedBookRequest } = await import("./bookSync");
      const ping = await boundedBookRequest(() => client.pingPadSync(0, {}), new AbortController().signal);
      if (isModernBookHub(ping)) {
        const result = await syncBookPass(client, { ...options, ping, selected: { kind, id: padId } });
        return result.books.some(book => book.kind === kind && book.id === padId && ["synced", "unchanged"].includes(book.status));
      }
    } catch { return false; }
  }
  if (kind === "problem") return false;
  if (kind === "whiteboard") {
    const notebook = await getWhiteboardNotebook(padId);
    if (!notebook) return false;
    const written = await putPadRecord(client, "whiteboard", {
      ...notebook.authoredExtras,
    ...artifactCatalogFields(notebook.artifacts, { kind: "whiteboard", id: notebook.id }),
      id: notebook.id,
      title: notebook.title,
      updated_at: notebook.updatedAt,
      page_count: notebook.pageCount,
      sync_seq: seq,
      board: notebook.board,
      agent: notebook.agent ?? [],
    });
    await acceptHubAgent("whiteboard", padId, written.agent);
    await markHubAck("whiteboard", padId, written.updated_at ?? notebook.updatedAt);
  } else {
    const doc = await getAnnotateDoc(padId);
    if (!doc) return false;
    const written = await putPadRecord(client, "annotate", {
      ...doc.authoredExtras,
    ...artifactCatalogFields(doc.artifacts, { kind: "annotate", id: doc.id }),
      id: doc.id,
      name: doc.name,
      ...(doc.label?.trim() ? { label: doc.label.trim() } : {}),
      hash: doc.hash,
      doc_type: doc.docType,
      updated_at: doc.updatedAt,
      sync_seq: seq,
      source: doc.source,
      footnotes: doc.footnotes ?? [],
      board: doc.board,
      agent: doc.agent ?? [],
    });
    await acceptHubAgent("annotate", padId, written.agent);
    await markHubAck("annotate", padId, written.updated_at ?? doc.updatedAt);
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
        ...(row.artifactBundle ? { artifactBundle: parseArtifactSnapshotBundle(row.artifactBundle, { kind, id: padId }) } : {}),
        ...(row.ink ? { ink: row.ink } : {}),
        ...(row.edges ? { edges: row.edges } : {}),
        ...(typeof row.source === "string" ? { source: row.source } : {}),
        ...(row.footnoteBoards ? { footnoteBoards: row.footnoteBoards } : {}),
        ...(row.footnoteInk ? { footnoteInk: row.footnoteInk } : {}),
      },
    });
  }
  return true;
}

function isConflict(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409;
}

function boardLooksCorrupt(board: unknown): boolean {
  if (!board || typeof board !== "object") return true;
  const blob = board as BoardBlob;
  return blob.v !== 1 || !Array.isArray(blob.elements);
}

export interface HubLibraryPullReport {
  added: string[];
  repaired: string[];
  failures: {name:string;message:string}[];
}
export class HubLibraryPullError extends Error {
  constructor(message:string, readonly report:HubLibraryPullReport) { super(message); }
}

/** Explicit discovery also repairs missing source bytes, without replacing local edits. */
export async function discoverHubPads(client: LcClient, report:HubLibraryPullReport = {added:[],repaired:[],failures:[]}): Promise<number> {
  if (!loadPadHub() && isAndroidDevice()) throw new Error("Connect to your hub before pulling files.");
  const { boundedBookRequest } = await import("./bookSync");
  const { syncBookPass, isModernBookHub } = await import("./bookSyncPass");
  const digest = await boundedBookRequest(() => client.pingPadSync(0, {}), new AbortController().signal);
  if (isModernBookHub(digest)) {
    const before = new Set([...listWhiteboardNotebooks().map(row => `whiteboard:${row.id}`), ...listAnnotateDocs().map(row => `annotate:${row.id}`)]);
    const result = await syncBookPass(client, { ping: digest, libraryPull: true });
    for (const book of result.books) {
      const remote = digest.books?.find(row => row.kind === book.kind && row.id === book.id);
      const name = String(remote && "record" in remote ? remote.record?.label ?? remote.record?.title ?? remote.record?.name ?? "Book" : "Book");
      if (book.status === "failed" || book.status === "needs_choice") {
        const { bookFailureMessage } = await import("./bookSyncMessages");
        report.failures.push({ name, message: bookFailureMessage(book, true) });
      }
      else if (book.status === "synced") (before.has(`${book.kind}:${book.id}`) ? report.repaired : report.added).push(name);
    }
    return report.added.length;
  }
  const [whiteboards, documents] = await Promise.all([
    client.listWhiteboardPads(), client.listAnnotatePads(),
  ]);
  let imported = 0;
  const failures: string[] = [];
  for (const row of whiteboards) {
    if (listWhiteboardTrash().some((entry) => entry.id === row.id)) continue;
    const existing = await getWhiteboardNotebook(row.id);
    if (existing) {
      if (digest.ink?.some(page => page.kind === "whiteboard" && page.key === row.id)) {
        try {
          if (await pullInkPagesOverLocal(client,"whiteboard",row.id,[],digest.ink,true)) report.repaired.push(row.title);
        } catch(cause) { report.failures.push({name:row.title,message:String(cause)});failures.push(`${row.title}: ${String(cause)}`); }
      }
      continue;
    }
    try {
      let board = row.board as BoardBlob;
      if (boardLooksCorrupt(board)) throw new Error(`“${row.title}” has an unreadable board on the hub.`);
      // Older whiteboards advertised the empty viewport slots [0,1]. Their
      // single frame stores all actual strokes on 1; 0 is only a placeholder.
      // Narrow compatibility to that exact shape and a confirmed page-1 upload.
      const ids = board.inkPages?.pageIds;
      const pages = digest.ink?.filter(page => page.kind === "whiteboard" && page.key === row.id) ?? [];
      if (ids?.length === 2 && ids.includes(0) && ids.includes(1) &&
          pages.some(page => page.page_id === 1) && !pages.some(page => page.page_id === 0)) {
        board = {...board, inkPages:{v:1,pageIds:[1]}};
      }
      await pullInkPagesOverLocal(client, "whiteboard", row.id, board.inkPages?.pageIds, digest.ink);
      // Dependencies first; do not offer a notebook that downloaded only its name.
      if (await getWhiteboardNotebook(row.id) || listWhiteboardTrash().some((entry) => entry.id === row.id)) continue;
      await applyHubWhiteboard({...row, board}, { emitReload: false, client });
      imported++;
      report.added.push(row.title);
    } catch (cause) {
      failures.push(`“${row.title}”: ${cause instanceof Error ? cause.message : String(cause)}`);
      report.failures.push({name:row.title,message:cause instanceof Error ? cause.message : String(cause)});
    }
  }
  for (const row of documents) {
    if (listAnnotateTrash().some((entry) => entry.id === row.id)) continue;
    const existing = await getAnnotateDoc(row.id);
    try {
      const board = row.board as BoardBlob;
      const hash = existing?.hash ?? row.hash;
      const type = existing?.docType ?? row.doc_type;
      if ((type === "pdf" || type === "epub") && !(await getDocBytes(hash))) {
        const bytes = await client.getDocBytes(hash);
        if (!bytes?.byteLength || !bytesMatchDocHash(hash, bytes)) {
          throw new Error(`The source file for “${row.name}” is not available on the hub yet.`);
        }
        await putDocBytes(hash, bytes);
        if (existing) report.repaired.push(existing.name);
      }
      if (existing) {
        if (digest.ink?.some(page => page.kind === "annotate" && page.key === row.id) &&
            await pullInkPagesOverLocal(client,"annotate",row.id,[],digest.ink,true)) {
          if (!report.repaired.includes(existing.name)) report.repaired.push(existing.name);
        }
        continue;
      }
      if (boardLooksCorrupt(board)) throw new Error(`“${row.name}” has an unreadable board on the hub.`);
      await pullInkPagesOverLocal(client, "annotate", row.id, board.inkPages?.pageIds, digest.ink);
      const boards = row.footnote_boards as Record<string, { board: BoardBlob }> | undefined;
      for (const [wbId, scratch] of Object.entries(boards ?? {})) {
        await pullInkPagesOverLocal(client, "annotate", footnoteInkHubKey(row.id, wbId), scratch.board.inkPages?.pageIds, digest.ink);
      }
      if (await getAnnotateDoc(row.id) || listAnnotateTrash().some((entry) => entry.id === row.id)) continue;
      await applyHubAnnotate(row, { emitReload: false, client });
      imported++;
      report.added.push(row.name);
    } catch (cause) {
      failures.push(`“${row.name}”: ${cause instanceof Error ? cause.message : String(cause)}`);
      report.failures.push({name:row.name,message:cause instanceof Error ? cause.message : String(cause)});
    }
  }
  if (failures.length) {
    // An incomplete older upload must not hide unrelated, complete pads.
    // Keep reporting the failures; never publish a pad without its ink/source.
    const added = imported ? `Added ${imported} ${imported === 1 ? "pad" : "pads"}. ` : "";
    throw new HubLibraryPullError(`${added}Could not download ${failures.length} ${failures.length === 1 ? "pad" : "pads"}: ${failures.join("; ")}`,report);
  }
  return imported;
}

export async function pullMissingHubFiles(client:LcClient):Promise<HubLibraryPullReport> {
  const report:HubLibraryPullReport={added:[],repaired:[],failures:[]};
  try { await discoverHubPads(client,report); }
  catch (error) { if (!(error instanceof HubLibraryPullError)) throw error; }
  return report;
}

export async function pullPads(client: LcClient): Promise<void> {
  if (client.pingPadSync) {
    const { syncBookPass, isModernBookHub } = await import("./bookSyncPass");
    const { boundedBookRequest } = await import("./bookSync");
    const ping = await boundedBookRequest(() => client.pingPadSync(0, {}), new AbortController().signal);
    if (isModernBookHub(ping)) { await syncBookPass(client, { ping, libraryPull: true }); return; }
  }
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
    await downloadArtifactAssets(client, artifactCatalogFields(row.artifacts, { kind: "whiteboard", id: row.id }).artifacts);
    const after = await getWhiteboardNotebook(row.id);
    if (after?.updatedAt !== local?.updatedAt || after?.syncSeq !== local?.syncSeq ||
        (after && !boardLooksCorrupt(after.board)) || listWhiteboardTrash().some((entry) => entry.id === row.id)) continue;
    await restoreWhiteboardNotebook({
      ...artifactCatalogFields(row.artifacts, { kind: "whiteboard", id: row.id }),
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      pageCount: row.page_count,
      board: row.board as BoardBlob,
      agent: mergeAgentMessages(local?.agent ?? [], Array.isArray(row.agent) ? row.agent : []),
      syncSeq: row.sync_seq,
      hubAckUpdatedAt: row.updated_at,
    });
  }

  const trashedAn = new Set(listAnnotateTrash().map((row) => row.id));
  for (const row of annotate) {
    if (isCameraBusy()) return;
    if (trashedAn.has(row.id)) continue;
    const local = await getAnnotateDoc(row.id);
    const missing = !local || boardLooksCorrupt(local.board);
    if (!missing) continue;
    await downloadArtifactAssets(client, artifactCatalogFields(row.artifacts, { kind: "annotate", id: row.id }).artifacts);
    const after = await getAnnotateDoc(row.id);
    if (after?.updatedAt !== local?.updatedAt || after?.syncSeq !== local?.syncSeq ||
        (after && !boardLooksCorrupt(after.board)) || listAnnotateTrash().some((entry) => entry.id === row.id)) continue;
    await restoreAnnotateDoc({
      ...artifactCatalogFields(row.artifacts, { kind: "annotate", id: row.id }),
      id: row.id,
      name: row.name,
      hash: row.hash,
      docType: (row.doc_type as DocType) || "markdown",
      updatedAt: row.updated_at,
      source: row.source ?? "",
      board: row.board as BoardBlob,
      footnotes: Array.isArray(row.footnotes) ? (row.footnotes as DocFootnote[]) : [],
      agent: mergeAgentMessages(local?.agent ?? [], Array.isArray(row.agent) ? row.agent : []),
      syncSeq: row.sync_seq,
      hubAckUpdatedAt: row.updated_at,
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
  if (isPadHubOffline()) return;
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
  const states = await run<SyncState[]>(STORE_SYNC_STATE, "readonly", store => store.getAll()).catch(() => []);
  const pendingDeletes = new Set(states.filter(state => state.lifecycle?.action === "delete").map(state => `${state.kind}:${state.id}`));
  const pendingDelete = (kind: PadKindSync, id: string) => pendingDeletes.has(`${kind}:${id}`);
  const trashWb = new Set(listWhiteboardTrash().map((row) => row.id));
  const trashAn = new Set(listAnnotateTrash().map((row) => row.id));
  const conflictedPads = new Set<string>();
  const pendingChange = (kind: PadKindSync, id: string): boolean => pendingPadPushes.has(`${kind}:${id}`)
    || states.some(state => state.kind === kind && state.id === id && state.lifecycle !== null);

  for (const gone of ping.gone ?? []) {
    if (isCameraBusy()) return;
    const kind: PadKindSync =
      gone.kind === "annotate" ? "annotate" : gone.kind === "problem" ? "problem" : "whiteboard";
    const local = kind === "problem" ? await getProblemBoard(gone.id) :
      kind === "whiteboard" ? await getWhiteboardNotebook(gone.id) : await getAnnotateDoc(gone.id);
    if (pendingChange(kind, gone.id) || (local && local.updatedAt !== local.hubAckUpdatedAt)) {
      // A ping cannot discard work authored offline while recovery is sending it.
      conflictedPads.add(`${kind}:${gone.id}`);
      continue;
    }
    if (emit) emitPadHub({ kind, id: gone.id, op: "close" });
    if (gone.kind === "whiteboard") {
      if (listWhiteboardNotebooks().find((entry) => entry.id === gone.id)?.locked) continue;
      if (trashWb.has(gone.id)) {
        await markWhiteboardDeleteAcked(gone.id, true);
        continue;
      }
      await deleteWhiteboardNotebook(gone.id).catch(() => {});
    } else if (gone.kind === "annotate") {
      if (listAnnotateDocs().find((entry) => entry.id === gone.id)?.locked) continue;
      if (trashAn.has(gone.id)) {
        await markAnnotateDeleteAcked(gone.id, true);
        continue;
      }
      await deleteAnnotateDoc(gone.id).catch(() => {});
    } else if (gone.kind === "problem") {
      await deleteProblemBoard(gone.id).catch(() => {});
    }
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
      ...ping.whiteboard.map((row) => ({ kind: "whiteboard" as const, key: row.id })),
      ...ping.annotate.map((row) => ({ kind: "annotate" as const, key: row.id })),
    ];
    /*
     * Footnote scratch boards are ink keys too.
     *
     * `{padId}/fn/{wbId}`. The digest already names the ones the hub has, and
     * `syncInkPages` would pick those up on its own — but a board that only
     * exists here has no digest row, so nothing would ever push it. Ink arrives before the pad rows are published, so a live reload never
     * restores a newly advertised board with its previous or missing ink.
     */
    for (const row of listAnnotateDocs()) {
      for (const key of await footnoteInkKeys(row.id, ping.ink ?? [], () =>
        localFootnoteBoardIds(row.id),
      )) {
        pads.push({ kind: "annotate", key });
      }
    }
    const available = (kind: string, key: string) => {
      const parent = kind === "annotate" ? key.split("/fn/")[0]! : key;
      return !(kind === "annotate" ? trashAn : trashWb).has(parent) &&
        !pendingDeletes.has(`${kind}:${parent}`) &&
        !(ping.gone ?? []).some((row) => row.kind === kind && row.id === parent);
    };
    const conflicts = await syncInkPages(client,
      (ping.ink ?? []).filter((row) => available(row.kind, row.key)),
      pads.filter((pad) => available(pad.kind, pad.key)), since, { strict: true });
    if (conflicts.length > 0) {
      noteInkConflicts(conflicts);
      for (const row of conflicts) conflictedPads.add(`${row.kind}:${row.key.split("/fn/")[0]}`);
    }
    await syncEdges(client, ping.edges ?? [], ping.gone_edges ?? []);
  }
  // Required transfers must finish before metadata can cause an open page to reload.
  for (const row of ping.annotate) {
    if (conflictedPads.has(`annotate:${row.id}`) || trashAn.has(row.id) ||
        pendingDeletes.has(`annotate:${row.id}`)) continue;
    if ((row.doc_type === "pdf" || row.doc_type === "epub") && row.hash) {
      if (!(await getDocBytes(row.hash))) {
        const bytes = await client.getDocBytes(row.hash);
        if (!bytes?.byteLength || !bytesMatchDocHash(row.hash, bytes)) {
          throw new Error(`Document bytes are missing for ${row.name}`);
        }
        await putDocBytes(row.hash, bytes);
      }
    }
  }


  for (const row of ping.whiteboard) {
    if (isCameraBusy()) return;
    if (trashWb.has(row.id) || pendingDelete("whiteboard", row.id)) continue;
    if (pendingChange("whiteboard", row.id)) { conflictedPads.add(`whiteboard:${row.id}`); continue; }
    if (conflictedPads.has(`whiteboard:${row.id}`)) continue;
    const local = await getWhiteboardNotebook(row.id);
    if (pendingDelete("whiteboard", row.id)) continue;
    if (pendingChange("whiteboard", row.id)) { conflictedPads.add(`whiteboard:${row.id}`); continue; }
    if (local?.hubAckUpdatedAt != null && local.updatedAt > local.hubAckUpdatedAt &&
        row.updated_at > local.hubAckUpdatedAt) continue;
    if (local?.locked && local.deletedAt) continue;
    const stale =
      !local ||
      boardLooksCorrupt(local.board) ||
      row.updated_at > local.updatedAt;
    if (!stale) {
      await downloadArtifactAssets(client, artifactCatalogFields(row.artifacts, { kind: "whiteboard", id: row.id }).artifacts);
      await markWhiteboardHubAck(row.id, row.updated_at);
      continue;
    }
    await applyHubWhiteboard(row, { emitReload: emit, client });
  }

  for (const row of ping.annotate) {
    if (isCameraBusy()) return;
    if (trashAn.has(row.id) || pendingDelete("annotate", row.id)) continue;
    if (pendingChange("annotate", row.id)) { conflictedPads.add(`annotate:${row.id}`); continue; }
    if (conflictedPads.has(`annotate:${row.id}`)) continue;
    const local = await getAnnotateDoc(row.id);
    if (pendingDelete("annotate", row.id)) continue;
    if (pendingChange("annotate", row.id)) { conflictedPads.add(`annotate:${row.id}`); continue; }
    if (local?.hubAckUpdatedAt != null && local.updatedAt > local.hubAckUpdatedAt &&
        row.updated_at > local.hubAckUpdatedAt) continue;
    const stale =
      !local ||
      boardLooksCorrupt(local.board) ||
      row.updated_at > local.updatedAt;
    if (!stale) {
      await downloadArtifactAssets(client, artifactCatalogFields(row.artifacts, { kind: "annotate", id: row.id }).artifacts);
      await markAnnotateHubAck(row.id, row.updated_at);
      continue;
    }
    await applyHubAnnotate(row, { emitReload: emit, client });
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


  for (const row of ping.problem ?? []) {
    if (isCameraBusy()) return;
    if (pendingDelete("problem", row.id)) continue;
    if (pendingChange("problem", row.id)) { conflictedPads.add(`problem:${row.id}`); continue; }
    if (pendingPadPushes.get(`problem:${row.id}`)?.size) {
      conflictedPads.add(`problem:${row.id}`);
      continue;
    }
    const local = await getProblemBoard(row.id);
    if (pendingDelete("problem", row.id)) continue;
    if (pendingChange("problem", row.id)) { conflictedPads.add(`problem:${row.id}`); continue; }
    if (local && (local.artifacts || row.artifacts) && local.updatedAt !== local.hubAckUpdatedAt) {
      if (row.updated_at !== local.hubAckUpdatedAt) {
        stashProblemArtifactConflict(local, row);
        conflictedPads.add(`problem:${row.id}`);
      }
      // Neither replacement nor ACK is authorized for unsent local work.
      continue;
    }
    const stale =
      !local ||
      boardLooksCorrupt(local.board) ||
      row.updated_at > local.updatedAt;
    if (!stale) {
      await downloadArtifactAssets(client, artifactCatalogFields(row.artifacts, { kind: "problem", id: row.id }).artifacts);
      await markProblemHubAck(row.id, row.updated_at);
      continue;
    }
    await applyHubProblem(row, { emitReload: emit, client });
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

  // Keep unresolved pages in subsequent incremental pings.
  if (conflictedPads.size === 0) savePadSyncSince(ping.now);
}

/** When the attachment cache was last collected, in `localStorage`. */
const ARTIFACT_GC_AT_KEY = "lc-artifact-cache-gc-at";
/** Its copies are kept three days, so once a day is plenty. */
export const ARTIFACT_GC_EVERY_MS = 24 * 60 * 60 * 1000;

let sweeping: Promise<void> | null = null;

/**
 * Empty old trash and collect the attachment cache.
 *
 * One at a time: every mounted workspace asks, and each run walks the
 * library. The cache collection reads every content, board, snapshot and
 * queue row — seconds on a tablet, holding those stores the while — so it
 * runs at most once a day rather than on every launch.
 */
export function sweepPadTrash(now = Date.now()): Promise<void> {
  sweeping ??= (async () => {
    const { sweepWhiteboardTrash } = await import("./whiteboardStore");
    const { sweepAnnotateTrash } = await import("./annotateStore");
    await sweepWhiteboardTrash(now);
    await sweepAnnotateTrash(now);
    let last = 0;
    try { last = Number(localStorage.getItem(ARTIFACT_GC_AT_KEY)) || 0; } catch { /* no storage: collect */ }
    if (now - last < ARTIFACT_GC_EVERY_MS) return;
    const { collectArtifactCache } = await import("./artifactCacheGc");
    await collectArtifactCache(now).then(
      () => { try { localStorage.setItem(ARTIFACT_GC_AT_KEY, String(now)); } catch { /* next launch tries again */ } },
      () => {},
    );
  })().finally(() => { sweeping = null; });
  return sweeping;
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
    ...(payload.artifactBundle !== undefined ? {
      artifactBundle: await stageArtifactSnapshot(payload.artifactBundle, { kind, id: key }),
    } : {}),
    kind,
    key,
    tier,
    writtenAt: row.written_at,
    name: payload.name ?? key,
    board: payload.board as BoardBlob,
    footnotes: payload.footnotes,
    agent: payload.agent,
    pageCount: payload.pageCount,
    ...(payload.footnoteBoards ? { footnoteBoards: payload.footnoteBoards } : {}),
    ...(payload.footnoteInk ? { footnoteInk: payload.footnoteInk } : {}),
    ...(Array.isArray(payload.ink) ? { ink: payload.ink as PadSnapshot["ink"] } : {}),
    ...(Array.isArray(payload.edges) ? { edges: payload.edges as PadSnapshot["edges"] } : {}),
    ...(typeof payload.source === "string" ? { source: payload.source } : {}),
  };
  try {
    const { run: idbRun, STORE_SNAPSHOTS } = await import("./idb");
    await idbRun(STORE_SNAPSHOTS, "readwrite", (store) =>
      store.put(snap, `${kind}:${key}:${row.tier}`),
    );
  } catch (cause) {
    if (snap.artifactBundle) throw cause;
    /* legacy best-effort snapshot cache */
  }
}

export { PAD_SNAPSHOT_TIERS };
