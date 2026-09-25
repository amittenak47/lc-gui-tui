/**
 * Local multipage scratchpad notebooks — independent of the harness router.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { deleteContent, getContent, putParentContent, editParentContentArtifacts } from "./contentStore";
import type { ArtifactCatalogEdit } from "./artifactCatalogEdits";
import { deletePadSnapshots } from "./padSnapshotStore";
import { deleteInkPages, whiteboardDocKey } from "./inkPageStore";
import { setStorageItem } from "./storageQuota";
import { artifactCatalogFields, type ArtifactCatalog } from "./padArtifacts";

export const WHITEBOARD_LIBRARY_LIMIT = 50;
export const WHITEBOARD_PAGE_LIMIT = 10;
export const PAD_TRASH_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export class WhiteboardLibraryFullError extends Error {
  readonly code = "scratchpad-library-full" as const;
  constructor(message = "Whiteboard library is full") {
    super(message);
    this.name = "WhiteboardLibraryFullError";
  }
}

export type WhiteboardBoardBlob = BoardBlob;

export interface WhiteboardNotebookMeta {
  /** Local presence/revision hint only; never put the catalog in this index. */
  artifactRevision?: string;
  id: string;
  title: string;
  updatedAt: number;
  pageCount: number;
  /** Blocks trash. Local-only — not part of pads.db. */
  locked?: boolean;
  /**
   * The reader has confirmed a title (first Save, or a rename).
   *
   * Autosave writes a dated default without this, so the first explicit Save
   * can still offer a name. Local-only — the hub already stores `title`.
   */
  named?: boolean;
  deletedAt?: number;
  /** Payload permanently removed; retain tombstone until its hub delete is acknowledged. */
  purgedAt?: number;
  syncSeq?: number;
  deleteAcked?: boolean;
  lastTouch?: number;
  /** Last hub `updated_at` this device ACK'd. CAS base for the next live PUT. */
  hubAckUpdatedAt?: number;
  lastSyncedAt?: number;
}

export interface WhiteboardNotebook extends WhiteboardNotebookMeta {
  artifacts?: ArtifactCatalog;
  board: WhiteboardBoardBlob;
  agent: unknown[];
}

/**
 * The library as it was: whole notebooks, boards and coach threads, in one
 * string. Still read once to bring an existing library across; never written.
 */
const LEGACY_KEY = "lc.scratchpad.library.v1";
const MIGRATED_LEGACY_KEY = "whiteboard.notebook.library.v1";

/** Meta only. See `contentStore` for why the two halves are separated. */
const LIBRARY_KEY = "whiteboard.notebook.index.v1";
const PRE_RENAME_INDEX = "lc.scratchpad.index.v1";

/** The heavy half: the board, and the coach thread that goes with it. */
interface WhiteboardContent {
  artifacts?: ArtifactCatalog;
  board: WhiteboardBoardBlob;
  agent: unknown[];
}

function storageGet(...keys: string[]): string | null {
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return raw;
    } catch {
      /* private browsing */
    }
  }
  return null;
}

function legacyLibrary(): WhiteboardNotebook[] {
  try {
    const raw = storageGet(MIGRATED_LEGACY_KEY, LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WhiteboardNotebook[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        entry.board?.v === 1 &&
        Array.isArray(entry.board.elements),
    );
  } catch {
    return [];
  }
}

function readIndex(): WhiteboardNotebookMeta[] {
  try {
    const raw = storageGet(LIBRARY_KEY, PRE_RENAME_INDEX);
    if (!raw) {
      return legacyLibrary().map(({ id, title, updatedAt, pageCount }) => ({
        id,
        title,
        updatedAt,
        pageCount,
      }));
    }
    const parsed = JSON.parse(raw) as WhiteboardNotebookMeta[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry.id === "string");
  } catch {
    return [];
  }
}

/** Throws {@link StorageFullError} when the origin is out of room — see `storageQuota`. */
export const WHITEBOARD_LIBRARY_EVENT = "lc-whiteboard-library";

function writeIndex(entries: WhiteboardNotebookMeta[]): void {
  setStorageItem(LIBRARY_KEY, JSON.stringify(entries));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WHITEBOARD_LIBRARY_EVENT));
}

/** Synchronous on purpose — the library dialog renders names, not boards. */
export function listWhiteboardNotebooks(): WhiteboardNotebookMeta[] {
  return readIndex()
    .filter((entry) => !entry.deletedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listWhiteboardTrash(): WhiteboardNotebookMeta[] {
  return readIndex()
    .filter((entry) => entry.deletedAt && !entry.purgedAt)
    .sort((a, b) => (b.lastTouch ?? b.deletedAt ?? 0) - (a.lastTouch ?? a.deletedAt ?? 0));
}

function liveCount(): number {
  return readIndex().filter((entry) => !entry.deletedAt).length;
}

export function defaultWhiteboardTitle(now = Date.now()): string {
  return `Notebook ${new Date(now).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

/**
 * Rename one notebook, without touching its pages.
 *
 * Not a `saveWhiteboardNotebook` call: renaming is not drawing, and going
 * through the save path would freshen `updatedAt` and push the notebook to the
 * top of Recent for something nobody sketched. Same reasoning as
 * `setAnnotateDocLabel`. Marks the notebook as user-named so the first-Save
 * prompt does not fire again.
 */
export function renameWhiteboardNotebook(id: string, title: string): boolean {
  const index = readIndex();
  const meta = index.find((entry) => entry.id === id);
  const trimmed = title.trim();
  if (!meta || !trimmed) return false;
  if (meta.title === trimmed && meta.named) return false;
  writeIndex(
    index.map((entry) =>
      entry.id === id ? { ...entry, title: trimmed, named: true } : entry,
    ),
  );
  return true;
}

/** True once the reader has confirmed a title (or renamed). */
export function whiteboardIsNamed(id: string | null | undefined): boolean {
  if (!id) return false;
  return Boolean(readIndex().find((entry) => entry.id === id && !entry.deletedAt)?.named);
}

export function whiteboardLibraryCount(): number {
  return liveCount();
}

export async function getWhiteboardNotebook(id: string): Promise<WhiteboardNotebook | null> {
  let meta = readIndex().find((entry) => entry.id === id);
  if (!meta) return null;
  const content = await getContent<WhiteboardContent>(id);
  if (content?.board) {
    const fields = artifactCatalogFields(content.artifacts, { kind: "whiteboard", id });
    if (fields.artifacts && meta.artifactRevision !== fields.artifacts.revision) {
      const index = readIndex();
      const latest = index.find((entry) => entry.id === id);
      // Recover an interrupted content->index update, but never downgrade an
      // index changed by another window after this content read began.
      if (latest && latest.artifactRevision === meta.artifactRevision) {
        meta = { ...latest, artifactRevision: fields.artifacts.revision, updatedAt: Math.max(Date.now(), latest.updatedAt + 1) };
        writeIndex([meta, ...index.filter((entry) => entry.id !== id)]);
      }
    }
    return { ...meta, board: content.board, agent: Array.isArray(content.agent) ? content.agent : [],
      ...fields };
  }
  const legacy = legacyLibrary().find((entry) => entry.id === id);
  if (!legacy) return null;
  return { ...meta, board: legacy.board, agent: Array.isArray(legacy.agent) ? legacy.agent : [] };
}

/**
 * An id no notebook in the library is using.
 *
 * The clock alone was not enough. A millisecond is a long time to a `localStorage`
 * write but not to two of them, and two notebooks created inside the same one
 * got the same id — so the second silently overwrote the first, and the library
 * quietly lost a notebook instead of gaining one. Rare by hand, routine when
 * anything creates notebooks in a loop.
 */
function freshId(library: readonly WhiteboardNotebookMeta[], now: number): string {
  const base = `scratch-${now.toString(36)}`;
  if (!library.some((entry) => entry.id === base)) return base;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${base}-${suffix.toString(36)}`;
    if (!library.some((entry) => entry.id === candidate)) return candidate;
  }
}

export async function saveWhiteboardNotebook(input: {
  artifacts?: ArtifactCatalog;
  id?: string;
  title?: string;
  board: WhiteboardBoardBlob;
  agent?: unknown[];
  pageCount: number;
}): Promise<WhiteboardNotebook> {
  const library = readIndex();
  const now = Date.now();
  const id = input.id ?? freshId(library, now);
  const existing = library.find((entry) => entry.id === id);
  if (!existing && liveCount() >= WHITEBOARD_LIBRARY_LIMIT) {
    throw new WhiteboardLibraryFullError(
      `At most ${WHITEBOARD_LIBRARY_LIMIT} whiteboard notebooks — delete one to save another.`,
    );
  }
  const title = input.title?.trim() || existing?.title || defaultWhiteboardTitle(now);
  const named = Boolean(existing?.named) || Boolean(input.title?.trim());
  // An absent `agent` means "this caller has no opinion", not "the thread is
  // empty" — the board autosave saves without one and must not wipe the chat.
  const prior = !Array.isArray(input.agent) || (existing?.artifactRevision && input.artifacts === undefined)
    ? await getContent<WhiteboardContent>(id) : null;
  const agent = Array.isArray(input.agent) ? input.agent : prior?.agent ?? [];
  const artifactFields = artifactCatalogFields(
    input.artifacts === undefined ? prior?.artifacts : input.artifacts,
    { kind: "whiteboard", id },
  );
  const meta: WhiteboardNotebookMeta = {
    id,
    ...(artifactFields.artifacts ? { artifactRevision: artifactFields.artifacts.revision } : {}),
    title,
    updatedAt: now,
    pageCount: Math.min(WHITEBOARD_PAGE_LIMIT, Math.max(1, input.pageCount)),
    ...(existing?.locked ? { locked: true } : {}),
    ...(named ? { named: true } : {}),
    syncSeq: existing?.syncSeq ?? 0,
    lastTouch: now,
    lastSyncedAt: existing?.lastSyncedAt,
    ...(existing?.hubAckUpdatedAt != null ? { hubAckUpdatedAt: existing.hubAckUpdatedAt } : {}),
  };
  const saved = await putParentContent({ kind: "whiteboard", id }, {
    board: input.board, agent, artifacts: input.artifacts,
  } satisfies WhiteboardContent);
  if (saved.artifacts) meta.artifactRevision = saved.artifacts.revision;
  const latest = readIndex().find((entry) => entry.id === id);
  if (existing && (!latest || latest.deletedAt !== undefined)) throw new Error("Notebook was removed during save; it was not restored.");
  if (latest) {
    meta.updatedAt = Math.max(meta.updatedAt, latest.updatedAt + 1);
    meta.syncSeq = latest.syncSeq;
    meta.hubAckUpdatedAt = latest.hubAckUpdatedAt;
    meta.lastSyncedAt = latest.lastSyncedAt;
    if (latest.locked) meta.locked = true; else delete meta.locked;
  }
  writeIndex([meta, ...readIndex().filter((entry) => entry.id !== id)]);
  return { ...meta, ...saved };
}

/** Update only attachment metadata; never write an old scene back after preflight. */
export async function editWhiteboardArtifacts(
  id: string, expectedCatalogRevision: string | null, edit: ArtifactCatalogEdit,
): Promise<ArtifactCatalog> {
  const assertLive = () => {
    const meta = readIndex().find((row) => row.id === id);
    if (!meta || meta.deletedAt !== undefined) throw new Error("Notebook was removed; attachment was not published.");
  };
  const artifacts = await editParentContentArtifacts({ kind: "whiteboard", id }, expectedCatalogRevision, edit, assertLive);
  assertLive();
  const index = readIndex();
  const meta = index.find((row) => row.id === id)!;
  writeIndex([{ ...meta, artifactRevision: artifacts.revision, updatedAt: Math.max(Date.now(), meta.updatedAt + 1) },
    ...index.filter((row) => row.id !== id)]);
  return artifacts;
}

export function markWhiteboardHubAck(id: string, updatedAt: number): void {
  const existing = readIndex().find((entry) => entry.id === id);
  if (!existing) return;
  writeIndex([
    { ...existing, hubAckUpdatedAt: updatedAt, lastSyncedAt: Date.now() },
    ...readIndex().filter((entry) => entry.id !== id),
  ]);
}

export function setWhiteboardNotebookLocked(id: string, locked: boolean): void {
  const library = readIndex();
  const existing = library.find((entry) => entry.id === id);
  if (!existing) return;
  const next: WhiteboardNotebookMeta = { ...existing };
  if (locked) next.locked = true;
  else delete next.locked;
  writeIndex([next, ...library.filter((entry) => entry.id !== id)]);
}

export async function trashWhiteboardNotebook(id: string, now = Date.now()): Promise<number | null> {
  const existing = readIndex().find((entry) => entry.id === id);
  if (!existing || existing.locked) return null;
  const seq = (existing.syncSeq ?? 0) + 1;
  const next: WhiteboardNotebookMeta = {
    ...existing,
    deletedAt: now,
    syncSeq: seq,
    deleteAcked: false,
    lastTouch: now,
  };
  writeIndex([next, ...readIndex().filter((entry) => entry.id !== id)]);
  return seq;
}

export function markWhiteboardDeleteAcked(id: string, acked: boolean): void {
  const existing = readIndex().find((entry) => entry.id === id);
  if (!existing?.deletedAt) return;
  writeIndex([
    { ...existing, deleteAcked: acked },
    ...readIndex().filter((entry) => entry.id !== id),
  ]);
}

export function bumpWhiteboardSyncSeq(id: string): number {
  const existing = readIndex().find((entry) => entry.id === id);
  if (!existing) return 0;
  const seq = (existing.syncSeq ?? 0) + 1;
  const next = { ...existing, syncSeq: seq, lastTouch: Date.now() };
  writeIndex([next, ...readIndex().filter((entry) => entry.id !== id)]);
  return seq;
}

export async function restoreWhiteboardFromTrash(id: string): Promise<WhiteboardNotebook | null> {
  const existing = readIndex().find((entry) => entry.id === id);
  if (!existing?.deletedAt || existing.purgedAt) return null;
  if (liveCount() >= WHITEBOARD_LIBRARY_LIMIT) {
    throw new WhiteboardLibraryFullError(
      `At most ${WHITEBOARD_LIBRARY_LIMIT} whiteboard notebooks — delete one to restore another.`,
    );
  }
  const seq = (existing.syncSeq ?? 0) + 1;
  const next: WhiteboardNotebookMeta = { ...existing, syncSeq: seq, lastTouch: Date.now() };
  delete next.deletedAt;
  delete next.deleteAcked;
  writeIndex([next, ...readIndex().filter((entry) => entry.id !== id)]);
  const content = await getContent<WhiteboardContent>(id);
  if (!content) return null;
  return { ...next, board: content.board, agent: content.agent,
    ...artifactCatalogFields(content.artifacts, { kind: "whiteboard", id }) };
}

export async function sweepWhiteboardTrash(now = Date.now()): Promise<string[]> {
  const expired = readIndex().filter(
    (entry) =>
      entry.deletedAt &&
      entry.deleteAcked &&
      now - entry.deletedAt >= PAD_TRASH_TTL_MS,
  );
  const ids: string[] = [];
  for (const entry of expired) {
    await deleteWhiteboardNotebook(entry.id);
    ids.push(entry.id);
  }
  return ids;
}

export async function deleteWhiteboardNotebook(id: string, preserveTombstone = false): Promise<void> {
  const existing = readIndex().find((entry) => entry.id === id);
  if (preserveTombstone && !existing?.deletedAt) throw new Error("Only trashed notebooks can be permanently deleted.");
  if (!preserveTombstone && existing?.locked) return;
  writeIndex(readIndex().flatMap(entry => entry.id !== id ? [entry] : preserveTombstone ? [{...entry,purgedAt:Date.now(),locked:false}] : []));
  await deleteContent(id);
  void deletePadSnapshots("whiteboard", id).catch(() => {});
  // Its links go too — see `deleteAnnotateDoc` for why both directions.
  void import("./noteLinks")
    .then((links) => links.deleteEdgesFor({ type: "whiteboard", id }))
    .catch(() => {});
  void deleteInkPages(whiteboardDocKey(id)).catch(() => {});
}

/**
 * Put a notebook back exactly as it was, for Discard.
 *
 * Not {@link saveWhiteboardNotebook}: that one is a *save*, so it stamps a new
 * `updatedAt` and enforces the library limit. Neither is right here. Discard
 * has to leave no trace of the session — including in the sort order, where a
 * freshened timestamp would jump a notebook to the top of the library that the
 * writer just said they did not want to keep. The limit cannot bite either,
 * since this only ever restores an entry that was already in the library.
 */
export async function restoreWhiteboardNotebook(entry: WhiteboardNotebook): Promise<void> {
  const { board, agent, artifacts, ...meta } = entry;
  const prior = artifacts === undefined && readIndex().find((row) => row.id === entry.id)?.artifactRevision
    ? await getContent<WhiteboardContent>(entry.id) : null;
  const artifactFields = artifactCatalogFields(
    artifacts === undefined ? prior?.artifacts : artifacts,
    { kind: "whiteboard", id: entry.id },
  );
  delete meta.artifactRevision;
  if (artifactFields.artifacts) meta.artifactRevision = artifactFields.artifacts.revision;
  const saved = await putParentContent({ kind: "whiteboard", id: entry.id }, {
    board, agent: agent ?? [], artifacts,
  } satisfies WhiteboardContent, { allowCatalogReplacement: true });
  if (saved.artifacts) meta.artifactRevision = saved.artifacts.revision;
  writeIndex([meta, ...readIndex().filter((existing) => existing.id !== entry.id)]);
}

/** Migrate the pre-library single-slot keys if present. */
export async function migrateLegacyWhiteboard(
  pageCountFromElements: (elements: unknown[]) => number,
): Promise<void> {
  const LEGACY_BOARD = "lc.scratchpad.board.v1";
  const LEGACY_AGENT = "lc.scratchpad.agent.v1";
  const MIGRATED_BOARD = "whiteboard.notebook.board.v1";
  const MIGRATED_AGENT = "whiteboard.notebook.agent.v1";
  try {
    const raw = storageGet(MIGRATED_BOARD, LEGACY_BOARD);
    if (!raw) return;
    if (readIndex().length > 0) {
      localStorage.removeItem(LEGACY_BOARD);
      localStorage.removeItem(LEGACY_AGENT);
      localStorage.removeItem(MIGRATED_BOARD);
      localStorage.removeItem(MIGRATED_AGENT);
      return;
    }
    const board = JSON.parse(raw) as WhiteboardBoardBlob;
    if (board?.v !== 1 || !Array.isArray(board.elements)) return;
    let agent: unknown[] = [];
    try {
      const agentRaw = storageGet(MIGRATED_AGENT, LEGACY_AGENT);
      if (agentRaw) {
        const parsed = JSON.parse(agentRaw);
        if (Array.isArray(parsed)) agent = parsed;
      }
    } catch {
      /* ignore */
    }
    await saveWhiteboardNotebook({
      title: "Recovered whiteboard",
      board,
      agent,
      pageCount: pageCountFromElements(board.elements),
    });
    localStorage.removeItem(LEGACY_BOARD);
    localStorage.removeItem(LEGACY_AGENT);
    localStorage.removeItem(MIGRATED_BOARD);
    localStorage.removeItem(MIGRATED_AGENT);
  } catch {
    /* ignore */
  }
}
