/**
 * Local multipage scratchpad notebooks — independent of lc serve.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { setStorageItem } from "./storageQuota";

export const SCRATCHPAD_LIBRARY_LIMIT = 20;
export const SCRATCHPAD_PAGE_LIMIT = 5;

export class ScratchpadLibraryFullError extends Error {
  readonly code = "scratchpad-library-full" as const;
  constructor(message = "Scratchpad library is full") {
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

const LIBRARY_KEY = "lc.scratchpad.library.v1";

function readLibrary(): ScratchNotebook[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
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

/** Throws {@link StorageFullError} when the origin is out of room — see `storageQuota`. */
function writeLibrary(entries: ScratchNotebook[]): void {
  setStorageItem(LIBRARY_KEY, JSON.stringify(entries));
}

export function listScratchNotebooks(): ScratchNotebookMeta[] {
  return readLibrary()
    .map(({ id, title, updatedAt, pageCount }) => ({ id, title, updatedAt, pageCount }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function scratchLibraryCount(): number {
  return readLibrary().length;
}

export function getScratchNotebook(id: string): ScratchNotebook | null {
  return readLibrary().find((entry) => entry.id === id) ?? null;
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
function freshId(library: readonly ScratchNotebook[], now: number): string {
  const base = `scratch-${now.toString(36)}`;
  if (!library.some((entry) => entry.id === base)) return base;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${base}-${suffix.toString(36)}`;
    if (!library.some((entry) => entry.id === candidate)) return candidate;
  }
}

export function saveScratchNotebook(input: {
  id?: string;
  title?: string;
  board: ScratchBoardBlob;
  agent?: unknown[];
  pageCount: number;
}): ScratchNotebook {
  const library = readLibrary();
  const now = Date.now();
  const id = input.id ?? freshId(library, now);
  const existing = library.find((entry) => entry.id === id);
  if (!existing && library.length >= SCRATCHPAD_LIBRARY_LIMIT) {
    throw new ScratchpadLibraryFullError(
      `At most ${SCRATCHPAD_LIBRARY_LIMIT} scratchpad notebooks — delete one to save another.`,
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
  const next: ScratchNotebook = {
    id,
    title,
    updatedAt: now,
    pageCount: Math.min(
      SCRATCHPAD_PAGE_LIMIT,
      Math.max(1, input.pageCount),
    ),
    board: input.board,
    agent: Array.isArray(input.agent) ? input.agent : existing?.agent ?? [],
  };
  const without = library.filter((entry) => entry.id !== id);
  writeLibrary([next, ...without]);
  return next;
}

export function deleteScratchNotebook(id: string): void {
  writeLibrary(readLibrary().filter((entry) => entry.id !== id));
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
export function restoreScratchNotebook(entry: ScratchNotebook): void {
  const without = readLibrary().filter((existing) => existing.id !== entry.id);
  writeLibrary([entry, ...without]);
}

/** Migrate the pre-library single-slot keys if present. */
export function migrateLegacyScratchpad(pageCountFromElements: (elements: unknown[]) => number): void {
  const LEGACY_BOARD = "lc.scratchpad.board.v1";
  const LEGACY_AGENT = "lc.scratchpad.agent.v1";
  try {
    const raw = localStorage.getItem(LEGACY_BOARD);
    if (!raw) return;
    if (readLibrary().length > 0) {
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
    saveScratchNotebook({
      title: "Recovered scratchpad",
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
