/**
 * Local multipage scratchpad notebooks — independent of lc serve.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { deleteContent, getContent, putContent } from "./contentStore";
import { deletePadSnapshots } from "./padSnapshotStore";
import { deleteInkPages, whiteboardDocKey } from "./inkPageStore";
import { setStorageItem } from "./storageQuota";

export const WHITEBOARD_LIBRARY_LIMIT = 50;
export const WHITEBOARD_PAGE_LIMIT = 10;

export class WhiteboardLibraryFullError extends Error {
  readonly code = "scratchpad-library-full" as const;
  constructor(message = "Whiteboard library is full") {
    super(message);
    this.name = "WhiteboardLibraryFullError";
  }
}

export type WhiteboardBoardBlob = BoardBlob;

export interface WhiteboardNotebookMeta {
  id: string;
  title: string;
  updatedAt: number;
  pageCount: number;
}

export interface WhiteboardNotebook extends WhiteboardNotebookMeta {
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
function writeIndex(entries: WhiteboardNotebookMeta[]): void {
  setStorageItem(LIBRARY_KEY, JSON.stringify(entries));
}

/** Synchronous on purpose — the library dialog renders names, not boards. */
export function listWhiteboardNotebooks(): WhiteboardNotebookMeta[] {
  return readIndex().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function whiteboardLibraryCount(): number {
  return readIndex().length;
}

export async function getWhiteboardNotebook(id: string): Promise<WhiteboardNotebook | null> {
  const meta = readIndex().find((entry) => entry.id === id);
  if (!meta) return null;
  const content = await getContent<WhiteboardContent>(id);
  if (content?.board) {
    return { ...meta, board: content.board, agent: Array.isArray(content.agent) ? content.agent : [] };
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
  if (!existing && library.length >= WHITEBOARD_LIBRARY_LIMIT) {
    throw new WhiteboardLibraryFullError(
      `At most ${WHITEBOARD_LIBRARY_LIMIT} whiteboard notebooks — delete one to save another.`,
    );
  }
  const title =
    input.title?.trim() ||
    existing?.title ||
    `Notebook ${new Date(now).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  // An absent `agent` means "this caller has no opinion", not "the thread is
  // empty" — the board autosave saves without one and must not wipe the chat.
  const agent = Array.isArray(input.agent)
    ? input.agent
    : (await getContent<WhiteboardContent>(id))?.agent ?? [];
  const meta: WhiteboardNotebookMeta = {
    id,
    title,
    updatedAt: now,
    pageCount: Math.min(WHITEBOARD_PAGE_LIMIT, Math.max(1, input.pageCount)),
  };
  writeIndex([meta, ...library.filter((entry) => entry.id !== id)]);
  await putContent(id, { board: input.board, agent } satisfies WhiteboardContent);
  return { ...meta, board: input.board, agent };
}

export async function deleteWhiteboardNotebook(id: string): Promise<void> {
  writeIndex(readIndex().filter((entry) => entry.id !== id));
  await deleteContent(id);
  void deletePadSnapshots("whiteboard", id).catch(() => {});
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
  const { board, agent, ...meta } = entry;
  writeIndex([meta, ...readIndex().filter((existing) => existing.id !== entry.id)]);
  await putContent(entry.id, { board, agent: agent ?? [] } satisfies WhiteboardContent);
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
