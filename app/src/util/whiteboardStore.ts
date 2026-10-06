/**
 * Local multipage scratchpad notebooks — independent of the harness router.
 */

import { retainRecoveryCopy } from "./syncRecovery";
import { hashBytes } from "./syncContent";
import type { BoardBlob } from "../canvas/BoardHandle";
import { getContent, putParentRecord, editParentContentArtifacts } from "./contentStore";
import type { ArtifactCatalogEdit } from "./artifactCatalogEdits";
import { artifactCatalogFields, type ArtifactCatalog } from "./padArtifacts";
import { getCachedBookMetadata, mutateLocalBook, type LocalBookEdit } from "./localBookStore";

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
  /** Unknown authored wire fields survive download, editing and re-upload. */
  authoredExtras?: Record<string, unknown>;
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

function legacyIndex(): WhiteboardNotebookMeta[] {
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

export const WHITEBOARD_LIBRARY_EVENT = "lc-whiteboard-library";

function readIndex(): WhiteboardNotebookMeta[] {
  return getCachedBookMetadata<WhiteboardNotebookMeta>("whiteboard", legacyIndex());
}

async function editMetadata<T>(id: string, edit: (meta: WhiteboardNotebookMeta | null, ctx: LocalBookEdit) => T,
  authored = true): Promise<T> {
  return mutateLocalBook({ kind: "whiteboard", id }, { authored }, ctx => edit(ctx.metadata as WhiteboardNotebookMeta | null, ctx));
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
export async function renameWhiteboardNotebook(id: string, title: string): Promise<boolean> {
  const trimmed = title.trim();
  if (!trimmed) return false;
  return editMetadata(id, (meta, ctx) => {
    if (!meta || meta.title === trimmed && meta.named) return false;
    ctx.setMetadata({ ...meta, kind: "whiteboard", title: trimmed, named: true });
    return true;
  });
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
        meta = await editMetadata(id, (current, ctx) => {
          if (!current || current.artifactRevision !== latest.artifactRevision) return current ?? latest;
          const next = { ...current, artifactRevision: fields.artifacts!.revision };
          ctx.setMetadata({ ...next, kind: "whiteboard" });
          return next;
        }, false);
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
  metadataIntent?: "rename";
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
  const accepted = await putParentRecord<WhiteboardContent, WhiteboardNotebookMeta>({ kind: "whiteboard", id }, {
    board: input.board, ...(Array.isArray(input.agent) ? { agent: input.agent } : {}), artifacts: input.artifacts,
  } as WhiteboardContent, { metadata: (current, saved) => {
    if (existing && (!current || current.deletedAt !== undefined)) throw new Error("Notebook was removed during save; it was not restored.");
    const next: WhiteboardNotebookMeta = { ...current, ...meta,
      title: current && current.named && input.metadataIntent !== "rename" ? current.title : title,
      updatedAt: Math.max(now, (current?.updatedAt ?? now - 1) + 1),
      syncSeq: current?.syncSeq ?? 0, lastSyncedAt: current?.lastSyncedAt,
      hubAckUpdatedAt: current?.hubAckUpdatedAt,
    };
    if (current?.locked) next.locked = true; else delete next.locked;
    if (current?.named || named) next.named = true;
    if (saved.artifacts) next.artifactRevision = saved.artifacts.revision;
    return next;
  } });
  return { ...accepted.metadata!, ...accepted.content };
}

/** Update only attachment metadata; never write an old scene back after preflight. */
export async function editWhiteboardArtifacts(
  id: string, expectedCatalogRevision: string | null, edit: ArtifactCatalogEdit,
): Promise<ArtifactCatalog> {
  const assertLive = () => {
    const meta = readIndex().find(row => row.id === id);
    if (!meta || meta.deletedAt !== undefined) throw new Error("Notebook was removed; attachment was not published.");
  };
  return editParentContentArtifacts({ kind: "whiteboard", id }, expectedCatalogRevision, edit, assertLive);
}

export async function markWhiteboardHubAck(id: string, updatedAt: number): Promise<void> {
  await editMetadata(id, (meta, ctx) => {
    if (meta) ctx.setMetadata({ ...meta, kind: "whiteboard", hubAckUpdatedAt: Math.max(meta.hubAckUpdatedAt ?? 0, updatedAt), lastSyncedAt: Date.now() });
  }, false);
}

export async function setWhiteboardNotebookLocked(id: string, locked: boolean): Promise<void> {
  await editMetadata(id, (meta, ctx) => {
    if (!meta || Boolean(meta.locked) === locked) return;
    const next = { ...meta, kind: "whiteboard" as const };
    if (locked) next.locked = true; else delete next.locked;
    ctx.setMetadata(next);
  });
}

export async function trashWhiteboardNotebook(id: string, now = Date.now()): Promise<number | null> {
  return editMetadata(id, (meta, ctx) => {
    if (!meta || meta.locked) return null;
    const seq = (meta.syncSeq ?? 0) + 1;
    ctx.setMetadata({ ...meta, kind: "whiteboard", deletedAt: now, syncSeq: seq, deleteAcked: false, lastTouch: now });
    ctx.markLifecycle("delete", seq, ctx.state.bootstrap ? null : ctx.state.appliedBookRev, ctx.state.lifecycle?.goneSeq ?? null);
    return seq;
  });
}

export async function markWhiteboardDeleteAcked(id: string, acked: boolean): Promise<void> {
  await editMetadata(id, (meta, ctx) => {
    if (meta?.deletedAt) ctx.setMetadata({ ...meta, kind: "whiteboard", deleteAcked: acked });
  }, false);
}

export async function bumpWhiteboardSyncSeq(id: string): Promise<number> {
  return editMetadata(id, (meta, ctx) => {
    if (!meta) return 0;
    const seq = (meta.syncSeq ?? 0) + 1;
    ctx.setMetadata({ ...meta, kind: "whiteboard", syncSeq: seq, lastTouch: Date.now() });
    return seq;
  });
}

export async function restoreWhiteboardFromTrash(id: string): Promise<WhiteboardNotebook | null> {
  const metadata = await editMetadata(id, (meta, ctx) => {
    if (!meta?.deletedAt || meta.purgedAt || !ctx.content) return null;
    if (liveCount() >= WHITEBOARD_LIBRARY_LIMIT) throw new WhiteboardLibraryFullError(`At most ${WHITEBOARD_LIBRARY_LIMIT} whiteboard notebooks ? delete one to restore another.`);
    const seq = Math.max(meta.syncSeq ?? 0, ctx.state.lifecycle?.goneSeq ?? 0) + 1;
    const next = { ...meta, kind: "whiteboard" as const, syncSeq: seq, lastTouch: Date.now() };
    delete next.deletedAt; delete next.deleteAcked;
    ctx.setMetadata(next);
    ctx.markLifecycle("restore", seq, ctx.state.bootstrap ? null : ctx.state.appliedBookRev, ctx.state.lifecycle?.goneSeq ?? null);
    return next;
  });
  if (!metadata) return null;
  const content = await getContent<WhiteboardContent>(id);
  return content ? { ...metadata, board: content.board, agent: content.agent,
    ...artifactCatalogFields(content.artifacts, { kind: "whiteboard", id }) } : null;
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
  await editMetadata(id, (meta, ctx) => {
    if (preserveTombstone && !meta?.deletedAt) throw new Error("Only trashed notebooks can be permanently deleted.");
    if (!preserveTombstone && meta?.locked) return;
    if (!meta) return;
    ctx.setMetadata(preserveTombstone ? { ...meta, kind: "whiteboard", purgedAt: Date.now(), locked: false } : null);
    ctx.setContent(null);
    if (!ctx.state.lifecycle) ctx.markLifecycle("delete", (meta.syncSeq ?? 0) + 1,
      ctx.state.bootstrap ? null : ctx.state.appliedBookRev, null);
  });
  // Snapshots, source bytes, recovery copies and retained ink survive purge.
  void import("./noteLinks").then(links => links.deleteEdgesFor({ type: "whiteboard", id })).catch(() => {});
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
  const captured = readIndex().find(row => row.id === entry.id) ?? null;
  await putParentRecord<WhiteboardContent, WhiteboardNotebookMeta>({ kind: "whiteboard", id: entry.id }, {
    board, agent: agent ?? [], artifacts,
  }, { allowCatalogReplacement: true, metadata: (current, saved) => {
    if (JSON.stringify(current) !== JSON.stringify(captured)) throw new Error("Notebook changed during restore; current work was kept.");
    const next = { ...current, ...meta };
    if (saved.artifacts) next.artifactRevision = saved.artifacts.revision;
    return next;
  } });
}

/** Migrate the pre-library single-slot keys if present. */
export async function migrateLegacyWhiteboard(
  pageCountFromElements: (elements: unknown[]) => number,
): Promise<void> {
  const LEGACY_BOARD = "lc.scratchpad.board.v1";
  const LEGACY_AGENT = "lc.scratchpad.agent.v1";
  const MIGRATED_BOARD = "whiteboard.notebook.board.v1";
  const MIGRATED_AGENT = "whiteboard.notebook.agent.v1";
  const raw = storageGet(MIGRATED_BOARD, LEGACY_BOARD);
  if (!raw) return;
  const board = JSON.parse(raw) as WhiteboardBoardBlob;
  if (board?.v !== 1 || !Array.isArray(board.elements)) throw new Error("The legacy whiteboard is unreadable. Its original copy was kept.");
  const agentRaw = storageGet(MIGRATED_AGENT, LEGACY_AGENT);
  const agent: unknown = agentRaw ? JSON.parse(agentRaw) : [];
  if (!Array.isArray(agent)) throw new Error("The legacy conversation is unreadable. Its original copy was kept.");
  const identity = await hashBytes(new TextEncoder().encode(JSON.stringify({ raw, agentRaw })));
  const id = `legacy-whiteboard-${identity}`;
  const metadata = { kind: "whiteboard" as const, id, title: "Recovered whiteboard", pageCount: pageCountFromElements(board.elements), updatedAt: 0 };
  await retainRecoveryCopy({ id: `legacy-slot:${identity}`, type: "record", kind: "whiteboard", bookId: id,
    provenance: { source: "legacy-single-whiteboard" }, record: { meta: metadata, payload: { board, agent } } });
  if (readIndex().length === 0) await saveWhiteboardNotebook({ ...metadata, board, agent });
  // The original keys remain readable; durable copy identity makes this restartable.
}
