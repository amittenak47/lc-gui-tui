/**
 * Annotation sets for markdown files — the library behind Markdown Ink.
 *
 * The markdown itself is never stored here and never modified: a document is
 * something the writer opened from disk, and this only holds what they drew on
 * top of it. Discarding an annotation session throws away ink, never the file.
 *
 * Entries are keyed by a hash of the markdown's *content* rather than its path.
 * A path is not available at all through a browser file picker, and it is the
 * wrong key regardless — the same notes moved to a new folder are the same
 * notes, and a file rewritten in place is not. Content is what the annotation
 * was drawn over, so content is what it belongs to. A file that changes under
 * an old annotation set gets a soft warning rather than a silent mismatch, and
 * the name is kept alongside purely so the library reads as file names.
 *
 * Mirrors `scratchpadStore` deliberately — same shape, same restore-for-discard
 * contract — so the two modes behave identically where the writer can tell.
 */

import type { BoardBlob } from "../canvas/BoardHandle";

export const MD_INK_LIBRARY_LIMIT = 30;

export class MdInkLibraryFullError extends Error {
  readonly code = "md-ink-library-full" as const;
  constructor(message = "Markdown annotation library is full") {
    super(message);
    this.name = "MdInkLibraryFullError";
  }
}

export interface MdInkDocMeta {
  id: string;
  /** File name as opened, for display. */
  name: string;
  /** Hash of the markdown this was drawn over. */
  hash: string;
  updatedAt: number;
}

export interface MdInkDoc extends MdInkDocMeta {
  board: BoardBlob;
}

const LIBRARY_KEY = "lc.md-ink.library.v1";

/**
 * FNV-1a over the markdown source.
 *
 * Not a security hash and does not need to be: it answers "is this the same
 * text I annotated last time", where the alternative to a cheap wrong answer is
 * an expensive right one on the main thread every time a file is opened.
 */
export function hashMarkdown(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `md${hash.toString(36)}-${source.length.toString(36)}`;
}

function readLibrary(): MdInkDoc[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as MdInkDoc[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.hash === "string" &&
        entry.board?.v === 1 &&
        Array.isArray(entry.board.elements),
    );
  } catch {
    return [];
  }
}

function writeLibrary(entries: MdInkDoc[]): void {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(entries));
}

export function listMdInkDocs(): MdInkDocMeta[] {
  return readLibrary()
    .map(({ id, name, hash, updatedAt }) => ({ id, name, hash, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMdInkDoc(id: string): MdInkDoc | null {
  return readLibrary().find((entry) => entry.id === id) ?? null;
}

/** The annotation set drawn over this exact markdown, if there is one. */
export function findMdInkDocByHash(hash: string): MdInkDoc | null {
  return readLibrary().find((entry) => entry.hash === hash) ?? null;
}

/** See the note on `freshId` in `scratchpadStore` — same millisecond, same trap. */
function freshId(library: readonly MdInkDoc[], now: number): string {
  const base = `mdink-${now.toString(36)}`;
  if (!library.some((entry) => entry.id === base)) return base;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${base}-${suffix.toString(36)}`;
    if (!library.some((entry) => entry.id === candidate)) return candidate;
  }
}

export function saveMdInkDoc(input: {
  id?: string;
  name: string;
  hash: string;
  board: BoardBlob;
}): MdInkDoc {
  const library = readLibrary();
  const now = Date.now();
  // An annotation set is identified by what it was drawn over, so re-saving the
  // same file updates its entry instead of stacking a second one beside it.
  const existing =
    (input.id ? library.find((entry) => entry.id === input.id) : null) ??
    library.find((entry) => entry.hash === input.hash) ??
    null;
  const id = existing?.id ?? input.id ?? freshId(library, now);
  if (!existing && library.length >= MD_INK_LIBRARY_LIMIT) {
    throw new MdInkLibraryFullError(
      `At most ${MD_INK_LIBRARY_LIMIT} annotated documents — delete one to keep another.`,
    );
  }
  const next: MdInkDoc = {
    id,
    name: input.name.trim() || existing?.name || "Untitled.md",
    hash: input.hash,
    updatedAt: now,
    board: input.board,
  };
  writeLibrary([next, ...library.filter((entry) => entry.id !== id)]);
  return next;
}

export function deleteMdInkDoc(id: string): void {
  writeLibrary(readLibrary().filter((entry) => entry.id !== id));
}

/**
 * Put an annotation set back exactly as it was, for Discard.
 *
 * Same contract as the scratchpad's: no fresh timestamp, no limit check. See
 * `restoreScratchNotebook` for why both of those would be wrong here.
 */
export function restoreMdInkDoc(entry: MdInkDoc): void {
  writeLibrary([entry, ...readLibrary().filter((existing) => existing.id !== entry.id)]);
}
