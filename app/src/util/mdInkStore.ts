/**
 * Annotation sets for markdown files — the library behind Markdown Ink.
 *
 * The file on disk is never written to. An entry holds the writer's ink and a
 * *copy* of the markdown it was drawn over — the copy only so that an entry can
 * be reopened from the library without hunting down the file again. Discarding
 * a session throws away annotations; nothing in here can touch the original.
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
import { deleteDocBytes } from "./docBytes";
import { sanitizeFootnotes, type DocFootnote } from "./docFootnotes";
import { setStorageItem } from "./storageQuota";

export const MD_INK_LIBRARY_LIMIT = 30;

/**
 * What kind of document an entry was drawn over.
 *
 * Markdown and code carry their source in the entry; PDF and EPUB keep their
 * bytes in IndexedDB under the same content hash (see `docBytes`), because a
 * textbook does not fit in a synchronous string store. Everything else about
 * an entry — the board, the footnotes, the hash it is keyed by — is identical
 * across the four, which is the point: one library, one save/discard contract,
 * one pad.
 *
 * Absent on entries written before PDF and EPUB existed, and those are all
 * markdown, so a missing value reads as `"markdown"` rather than as corrupt.
 */
export type DocType = "markdown" | "pdf" | "epub" | "code";

export function isBinaryDocType(docType: DocType): boolean {
  return docType === "pdf" || docType === "epub";
}

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
  /** Hash of the document this was drawn over — text for markdown, bytes otherwise. */
  hash: string;
  docType: DocType;
  updatedAt: number;
}

export interface MdInkDoc extends MdInkDocMeta {
  /**
   * The markdown or source text, so an entry can be reopened without hunting
   * for the file again.
   *
   * This is a copy of the writer's document, kept as the backdrop the ink was
   * drawn on — not a claim of ownership over it and never written back to disk.
   * Discard still only throws away annotations; the file on disk is untouched
   * by anything in this module.
   *
   * Empty for PDF and EPUB: their bytes are in IndexedDB under {@link hash},
   * because a textbook is orders of magnitude past what this store can hold.
   */
  source: string;
  board: BoardBlob;
  /**
   * Marks left by the reading session — see `docFootnotes`.
   *
   * Kept here rather than on the `BoardBlob` because a footnote is not a thing
   * on the canvas: it is anchored to characters in the source, and it has to
   * survive a board that gets cleared. Optional so entries saved before
   * footnotes existed still load.
   */
  footnotes?: DocFootnote[];
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
        typeof entry.source === "string" &&
        entry.board?.v === 1 &&
        Array.isArray(entry.board.elements),
    )
    .map((entry) => ({
      ...entry,
      // Entries written before PDF and EPUB existed are all markdown.
      docType: entry.docType ?? "markdown",
      footnotes: sanitizeFootnotes(entry.footnotes),
    }));
  } catch {
    return [];
  }
}

/** Throws {@link StorageFullError} when the origin is out of room — see `storageQuota`. */
function writeLibrary(entries: MdInkDoc[]): void {
  setStorageItem(LIBRARY_KEY, JSON.stringify(entries));
}

export function listMdInkDocs(): MdInkDocMeta[] {
  return readLibrary()
    .map(({ id, name, hash, docType, updatedAt }) => ({
      id,
      name,
      hash,
      docType,
      updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMdInkDoc(id: string): MdInkDoc | null {
  return readLibrary().find((entry) => entry.id === id) ?? null;
}

/** The annotation set drawn over this exact markdown, if there is one. */
export function findMdInkDocByHash(hash: string): MdInkDoc | null {
  return readLibrary().find((entry) => entry.hash === hash) ?? null;
}

/**
 * An annotation set for a file of this name, drawn over *different* text.
 *
 * The interesting case for a warning rather than a match. Edit a note between
 * two annotating sessions and the hash moves, so the old ink no longer belongs
 * to it — the marks would sit on lines that have shifted or gone. Silently
 * opening a blank page is the safe behaviour and a confusing one, because from
 * the outside it looks like the annotations were lost. Naming the stale set
 * lets the writer be told what happened.
 */
export function findStaleMdInkDoc(name: string, hash: string): MdInkDocMeta | null {
  const match = readLibrary().find((entry) => entry.name === name && entry.hash !== hash);
  if (!match) return null;
  const { id, name: entryName, hash: entryHash, docType, updatedAt } = match;
  return { id, name: entryName, hash: entryHash, docType, updatedAt };
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
  docType?: DocType;
  source: string;
  board: BoardBlob;
  footnotes?: readonly DocFootnote[];
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
    docType: input.docType ?? existing?.docType ?? "markdown",
    updatedAt: now,
    source: input.source,
    board: input.board,
    // Undefined means "this caller does not track footnotes", not "there are
    // none" — an autosave from a path that never loaded them must not wipe the
    // set the reading session built up.
    footnotes: input.footnotes ? [...input.footnotes] : existing?.footnotes ?? [],
  };
  writeLibrary([next, ...library.filter((entry) => entry.id !== id)]);
  return next;
}

export function deleteMdInkDoc(id: string): void {
  const library = readLibrary();
  const going = library.find((entry) => entry.id === id) ?? null;
  const kept = library.filter((entry) => entry.id !== id);
  writeLibrary(kept);
  /*
   * A binary document's bytes outlive its entry unless something removes them.
   *
   * They are keyed by content hash, so two entries can legitimately share one
   * blob — check before dropping it, or deleting one annotation set of a
   * textbook would take the textbook out from under the other. Best-effort:
   * a stranded blob is wasted space, not a broken library, and refusing to
   * delete the entry because IndexedDB was unhappy would be the worse trade.
   */
  if (going && isBinaryDocType(going.docType) && !kept.some((e) => e.hash === going.hash)) {
    void deleteDocBytes(going.hash).catch(() => {});
  }
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
