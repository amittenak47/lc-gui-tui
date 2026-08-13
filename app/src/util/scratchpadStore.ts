/**
 * Local multipage scratchpad notebooks — independent of lc serve.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { deleteContent, getContent, putContent } from "./contentStore";
import { deletePadSnapshots } from "./padSnapshotStore";
import { deleteInkPages, whiteboardDocKey } from "./inkPageStore";
import { setStorageItem } from "./storageQuota";

export const SCRATCHPAD_LIBRARY_LIMIT = 50;
export const SCRATCHPAD_PAGE_LIMIT = 10;

export class ScratchpadLibraryFullError extends Error {
  readonly code = "scratchpad-library-full" as const;
  constructor(message = "Whiteboard library is full") {
    super(message);
    this.name = "ScratchpadLibraryFullError";
  }
}

export type ScratchBoardBlob = BoardBlob;

export interface ScratchNotebookMeta {
  id: string;
  title: string;
  updatedAt: number;
  pageCount: number;
}

export interface ScratchNotebook extends ScratchNotebookMeta {
  board: ScratchBoardBlob;
  agent: unknown[];
}

/**
 * The library as it was: whole notebooks, boards and coach threads, in one
 * string. Still read once to bring an existing library across; never written.
 */
const LEGACY_KEY = "lc.scratchpad.library.v1";

/** Meta only. See `contentStore` for why the two halves are separated. */
const LIBRARY_KEY = "lc.scratchpad.index.v1";

/** The heavy half: the board, and the coach thread that goes with it. */
interface ScratchContent {
  board: ScratchBoardBlob;
  agent: unknown[];
}

function legacyLibrary(): ScratchNotebook[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ScratchNotebook[];
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

function readIndex(): ScratchNotebookMeta[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) {
      return legacyLibrary().map(({ id, title, updatedAt, pageCount }) => ({
        id,
        title,
        updatedAt,
        pageCount,
      }));
    }
    const parsed = JSON.parse(raw) as ScratchNotebookMeta[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry.id === "string");
  } catch {
    return [];
  }
}

/** Throws {@link StorageFullError} when the origin is out of room — see `storageQuota`. */
function writeIndex(entries: ScratchNotebookMeta[]): void {
  setStorageItem(LIBRARY_KEY, JSON.stringify(entries));
}

/** Synchronous on purpose — the library dialog renders names, not boards. */
export function listScratchNotebooks(): ScratchNotebookMeta[] {
  return readIndex().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function scratchLibraryCount(): number {
  return readIndex().length;
}

export async function getScratchNotebook(id: string): Promise<ScratchNotebook | null> {
  const meta = readIndex().find((entry) => entry.id === id);
  if (!meta) return null;
  const content = await getContent<ScratchContent>(id);
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
function freshId(library: readonly ScratchNotebookMeta[], now: number): string {
  const base = `scratch-${now.toString(36)}`;
  if (!library.some((entry) => entry.id === base)) return base;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${base}-${suffix.toString(36)}`;
    if (!library.some((entry) => entry.id === candidate)) return candidate;
  }
}

export async function saveScratchNotebook(input: {
  id?: string;
  title?: string;
  board: ScratchBoardBlob;
  agent?: unknown[];
  pageCount: number;
}): Promise<ScratchNotebook> {
  const library = readIndex();
  const now = Date.now();
  const id = input.id ?? freshId(library, now);
  const existing = library.find((entry) => entry.id === id);
  if (!existing && library.length >= SCRATCHPAD_LIBRARY_LIMIT) {
    throw new ScratchpadLibraryFullError(
      `At most ${SCRATCHPAD_LIBRARY_LIMIT} whiteboard notebooks — delete one to save another.`,
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
    : (await getContent<ScratchContent>(id))?.agent ?? [];
  const meta: ScratchNotebookMeta = {
    id,
    title,
    updatedAt: now,
    pageCount: Math.min(SCRATCHPAD_PAGE_LIMIT, Math.max(1, input.pageCount)),
  };
  writeIndex([meta, ...library.filter((entry) => entry.id !== id)]);
  await putContent(id, { board: input.board, agent } satisfies ScratchContent);
  return { ...meta, board: input.board, agent };
}

export async function deleteScratchNotebook(id: string): Promise<void> {
  writeIndex(readIndex().filter((entry) => entry.id !== id));
  await deleteContent(id);
  void deletePadSnapshots("whiteboard", id).catch(() => {});
  void deleteInkPages(whiteboardDocKey(id)).catch(() => {});
}

/**
 * Put a notebook back exactly as it was, for Discard.
 *
 * Not {@link saveScratchNotebook}: that one is a *save*, so it stamps a new
 * `updatedAt` and enforces the library limit. Neither is right here. Discard
 * has to leave no trace of the session — including in the sort order, where a
 * freshened timestamp would jump a notebook to the top of the library that the
 * writer just said they did not want to keep. The limit cannot bite either,
 * since this only ever restores an entry that was already in the library.
 */
export async function restoreScratchNotebook(entry: ScratchNotebook): Promise<void> {
  const { board, agent, ...meta } = entry;
  writeIndex([meta, ...readIndex().filter((existing) => existing.id !== entry.id)]);
  await putContent(entry.id, { board, agent: agent ?? [] } satisfies ScratchContent);
}

/** Migrate the pre-library single-slot keys if present. */
export async function migrateLegacyScratchpad(
  pageCountFromElements: (elements: unknown[]) => number,
): Promise<void> {
  const LEGACY_BOARD = "lc.scratchpad.board.v1";
  const LEGACY_AGENT = "lc.scratchpad.agent.v1";
  try {
    const raw = localStorage.getItem(LEGACY_BOARD);
    if (!raw) return;
    if (readIndex().length > 0) {
      localStorage.removeItem(LEGACY_BOARD);
      localStorage.removeItem(LEGACY_AGENT);
      return;
    }
    const board = JSON.parse(raw) as ScratchBoardBlob;
    if (board?.v !== 1 || !Array.isArray(board.elements)) return;
    let agent: unknown[] = [];
    try {
      const agentRaw = localStorage.getItem(LEGACY_AGENT);
      if (agentRaw) {
        const parsed = JSON.parse(agentRaw);
        if (Array.isArray(parsed)) agent = parsed;
      }
    } catch {
      /* ignore */
    }
    await saveScratchNotebook({
      title: "Recovered whiteboard",
      board,
      agent,
      pageCount: pageCountFromElements(board.elements),
    });
    localStorage.removeItem(LEGACY_BOARD);
    localStorage.removeItem(LEGACY_AGENT);
  } catch {
    /* ignore */
  }
}
