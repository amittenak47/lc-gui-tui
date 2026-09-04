/**
 * Annotation sets for markdown files — the library behind Markdown Ink.
 *
 * Two kinds of entry live here, and the difference is who owns the text.
 *
 * **Imported** (everything opened through the picker): the file on disk is
 * never written to. An entry holds the writer's ink and a *copy* of the
 * markdown it was drawn over — the copy only so that an entry can
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
 * **Owned** (`owned: true`, made by New file): there is no original. `source`
 * *is* the note, editing it is editing the document, and its hash moves every
 * time it is saved. Nothing about the storage differs — same index row, same
 * content record, same ink keys — only the claim over the text.
 *
 * Mirrors `whiteboardStore` deliberately — same shape, same restore-for-discard
 * contract, same coach thread on the entry — so the two modes behave identically
 * where the writer can tell.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { deleteContent, putContent, getContent } from "./contentStore";
import type { WebCapture, WebPadKind } from "./webCaptures";
import { deleteDocBytes } from "./docBytes";
import { sanitizeFootnotes, type DocFootnote } from "./docFootnotes";
import { deletePadSnapshots, renamePadSnapshots } from "./padSnapshotStore";
import { deleteInkPages, annotateDocKey, renameInkPages } from "./inkPageStore";
import { sweepFootnoteWhiteboards, whiteboardIdsOn } from "./footnoteWhiteboardStore";
import { setStorageItem } from "./storageQuota";
import { hashBytes } from "./docBytes";
import { webIdentityUrl } from "./webIdentity";

export const ANNOTATE_LIBRARY_LIMIT = 30;
export const ANNOTATE_TRASH_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * What kind of document an entry was drawn over.
 *
 * Markdown and code carry their source in the entry; PDF and EPUB keep their
 * bytes in IndexedDB under the same content hash (see `docBytes`), because a
 * textbook does not fit in a synchronous string store. A captured web page is
 * HTML text in the entry, hashed like markdown. Everything else about
 * an entry — the board, the footnotes, the hash it is keyed by — is identical
 * across those types, which is the point: one library, one save/discard
 * contract, one pad.
 *
 * Absent on entries written before PDF and EPUB existed, and those are all
 * markdown, so a missing value reads as `"markdown"` rather than as corrupt.
 */
export type DocType = "markdown" | "pdf" | "epub" | "code" | "web";

export function isBinaryDocType(docType: DocType): boolean {
  return docType === "pdf" || docType === "epub";
}

export class AnnotateLibraryFullError extends Error {
  readonly code = "md-ink-library-full" as const;
  constructor(message = "Markdown annotation library is full") {
    super(message);
    this.name = "AnnotateLibraryFullError";
  }
}

export interface AnnotateDocMeta {
  id: string;
  /** File name as opened, for display. */
  name: string;
  /** Hash of the document this was drawn over — text for markdown/code/web, bytes otherwise. */
  hash: string;
  docType: DocType;
  updatedAt: number;
  /**
   * What to call this set of annotations, when its file name is not enough.
   *
   * A file can carry several sets now, and they all share one `name` — a list
   * of three rows reading `dp.pdf` tells the reader nothing about which is
   * which. Renaming here renames the *set*: the file on disk is untouched and
   * the hash does not move. Absent on sets made before forks existed, and on
   * every set that is still the only one on its file, where the file name is
   * the better label anyway. See {@link annotateDocLabel}.
   */
  label?: string;
  /**
   * This note was written in the app, rather than opened from somewhere else.
   *
   * The distinction is about who owns the text. An imported file's `source` is
   * a *copy*, kept only so the set can be reopened without hunting for the file
   * again — the original is never written to, and nothing in here can touch it.
   * An owned note has no original: `source` is the note, and editing it is
   * editing the document rather than annotating a snapshot of one.
   *
   * Absent on everything opened through the file picker, and on every set made
   * before New file existed, so a missing value reads as "imported".
   */
  owned?: boolean;
  /**
   * Blocks trash in the library. Local-only — a ping will not overwrite it.
   */
  locked?: boolean;
  deletedAt?: number;
  syncSeq?: number;
  deleteAcked?: boolean;
  lastTouch?: number;
  hubAckUpdatedAt?: number;
}

/**
 * The name to show for one annotation set.
 *
 * Falls back to the date the set was last touched rather than to a counter:
 * "dp.pdf — 18 Aug" says something about which session it was, where
 * "dp.pdf (2)" only says it was not the first.
 */
export function annotateDocLabel(meta: AnnotateDocMeta): string {
  const label = meta.label?.trim();
  if (label) return label;
  const when = new Date(meta.updatedAt);
  if (Number.isNaN(when.getTime())) return meta.name;
  return `${meta.name} — ${when.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  })}`;
}

export interface AnnotateDoc extends AnnotateDocMeta {
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
   * Web snapshots store sanitised HTML here, hashed like markdown.
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
  /**
   * Coach transcript for this document.
   *
   * Whiteboard notebooks already keep this on the entry. Documents used to
   * skip it: a PDF mark only stored `rootId` + title, so reopening the book
   * restored the ribbon and lost the thread. Optional so older entries load.
   */
  agent?: unknown[];
  /** See {@link AnnotateContent.captures}. Web pads only. */
  captures?: WebCapture[];
  /** See {@link AnnotateContent.padKind}. Web pads only. */
  padKind?: WebPadKind;
}

/**
 * The library as it was: whole entries, content and all, in one string.
 *
 * Still read, once, to bring an existing library across — see
 * {@link adoptLegacyLibrary}. Never written again.
 */
const LEGACY_KEY = "lc.md-ink.library.v1";
const MIGRATED_LEGACY_KEY = "whiteboard.annotate.library.v1";

/** Meta only — thirty entries of a few hundred bytes each. */
const LIBRARY_KEY = "whiteboard.annotate.index.v1";
const PRE_RENAME_INDEX = "lc.md-ink.index.v1";

/** The heavy half of an entry, stored per-id in IndexedDB. See `contentStore`. */
interface AnnotateContent {
  source: string;
  board: BoardBlob;
  footnotes: DocFootnote[];
  agent: unknown[];
  /**
   * Older captures of a web page, kept because a mark still stands on one.
   *
   * `source` is always the newest, so every reader downstream is unchanged and
   * a pad with no history is exactly what it was. See `webCaptures` for the
   * retention rule.
   */
  captures?: WebCapture[];
  /** How the reader answered "page, or feed?" — remembered per pad. */
  padKind?: WebPadKind;
}

/**
 * FNV-1a over the text source (markdown, code, or captured HTML).
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

/**
 * The identity of a document, decided by kind.
 *
 * For anything the reader brought, identity is its **content**: the same file is
 * the same document wherever on disk it came from, which is what lets the
 * library reopen it without ever having known its path, and what makes two
 * copies of one textbook cost one entry.
 *
 * A web pad is the exception, and treating it like the rest was a bug. Its
 * "content" is a frozen copy this app made moments ago, so it changes every time
 * the page is frozen again — minting a second row in Recent, a second document
 * in `docs.db`, and orphaning the previous index with nothing to collect it. Its
 * identity is the **address**, which is the thing that did not change. See
 * {@link webIdentityUrl}.
 */
export function docIdentityHash(input: {
  docType: DocType;
  name: string;
  text?: string;
  bytes?: ArrayBuffer | null;
}): string {
  if (input.docType === "web") {
    const url = webIdentityUrl(input.name);
    // A web pad with an unparseable name is not a page anyone navigated to;
    // fall back to its text rather than inventing an identity for it.
    if (url) return hashMarkdown(url);
  }
  if (input.bytes) return hashBytes(input.bytes);
  return hashMarkdown(input.text ?? "");
}

/**
 * A PDF/EPUB open with no bytes must keep the library hash.
 *
 * Hashing an empty buffer (or the file name) invents a new identity, and a
 * later save can delete the real copy under the old hash. Reload-without-bytes
 * is the path that used to blank the paper after Keep server.
 */
export function existingHashIfEmptyBinary(
  docType: DocType,
  bytes: ArrayBuffer | null | undefined,
  existingHash: string | undefined,
): string | null {
  if (!isBinaryDocType(docType)) return null;
  if (bytes && bytes.byteLength > 0) return null;
  return existingHash?.trim() ? existingHash : null;
}


/**
 * Bring a library written by the old build across, once.
 *
 * Read-old-write-new rather than a migration pass: this runs lazily on the
 * first read, moves the meta over, and leaves the old key in place so a build
 * rolled back still finds its library. Content is *not* moved eagerly — the
 * legacy blob is left as a fallback for {@link readContent}, so nothing has to
 * succeed at a bulk write for someone's annotations to still open.
 */
function adoptLegacyLibrary(): AnnotateDocMeta[] {
  try {
    const raw =
      localStorage.getItem(MIGRATED_LEGACY_KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AnnotateDoc[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry) =>
          entry &&
          typeof entry.id === "string" &&
          typeof entry.hash === "string" &&
          entry.board?.v === 1,
      )
      .map(({ id, name, hash, docType, updatedAt }) => ({
        id,
        name,
        hash,
        // Entries written before PDF and EPUB existed are all markdown.
        docType: docType ?? "markdown",
        updatedAt,
      }));
  } catch {
    return [];
  }
}

/** The legacy entry for an id, if the old library is still on this device. */
function legacyEntry(id: string): AnnotateDoc | null {
  try {
    const raw =
      localStorage.getItem(MIGRATED_LEGACY_KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AnnotateDoc[];
    return Array.isArray(parsed) ? parsed.find((entry) => entry?.id === id) ?? null : null;
  } catch {
    return null;
  }
}

function readIndex(): AnnotateDocMeta[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY) ?? localStorage.getItem(PRE_RENAME_INDEX);
    if (!raw) return adoptLegacyLibrary();
    const parsed = JSON.parse(raw) as AnnotateDocMeta[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.id === "string" && typeof entry.hash === "string")
      .map((entry) => ({ ...entry, docType: entry.docType ?? "markdown" }));
  } catch {
    return [];
  }
}

/** Throws {@link StorageFullError} when the origin is out of room — see `storageQuota`. */
function writeIndex(entries: AnnotateDocMeta[]): void {
  setStorageItem(LIBRARY_KEY, JSON.stringify(entries));
}

/**
 * Listing is deliberately still synchronous.
 *
 * The library dialog renders thirty names; making it await would put a spinner
 * on a list that is a few kilobytes of text. It reads only the index, which is
 * the point of splitting content out — this used to `JSON.parse` every board in
 * the store to show their file names.
 */
export function listAnnotateDocs(): AnnotateDocMeta[] {
  return readIndex()
    .filter((entry) => !entry.deletedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * A note name nothing else in the library is already using.
 *
 * Two notes called `Untitled.md` are two rows a reader cannot tell apart, in
 * the one list — Recent — whose whole job is telling them apart. Naming is also
 * the last thing anyone wants to be made to do at the moment they are trying to
 * start writing, so "Untitled" has to stay an acceptable answer, and the app
 * has to make it unambiguous on the reader's behalf.
 *
 * The suffix goes before the extension (`Untitled (1).md`), the way a file
 * manager does it — a reader who exports these will find them sorted together,
 * and `Untitled.md (1)` would not open as markdown anywhere else.
 */
export function uniqueAnnotateName(name: string): string {
  const taken = new Set(
    readIndex()
      .filter((entry) => !entry.deletedAt)
      .map((entry) => entry.name.trim().toLowerCase()),
  );
  if (!taken.has(name.trim().toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

export function listAnnotateTrash(): AnnotateDocMeta[] {
  return readIndex()
    .filter((entry) => entry.deletedAt)
    .sort((a, b) => (b.lastTouch ?? b.deletedAt ?? 0) - (a.lastTouch ?? a.deletedAt ?? 0));
}

function liveAnnotateCount(): number {
  return readIndex().filter((entry) => !entry.deletedAt).length;
}

/**
 * Rename one annotation set, without touching its file or its content.
 *
 * Deliberately not a `saveAnnotateDoc` call: renaming is not editing, and
 * going through the save path would freshen `updatedAt` and move the set to
 * the top of Recent for something the reader did not draw.
 */
export function setAnnotateDocLabel(id: string, label: string): boolean {
  const index = readIndex();
  const meta = index.find((entry) => entry.id === id);
  if (!meta) return false;
  const trimmed = label.trim();
  const current = meta.label?.trim() ?? "";
  if (trimmed === current) return false;
  const next: AnnotateDocMeta = trimmed ? { ...meta, label: trimmed } : { ...meta };
  if (!trimmed) delete next.label;
  writeIndex(index.map((entry) => (entry.id === id ? next : entry)));
  return true;
}

/** True once the reader has named this set (owned notes count as named). */
export function annotateIsNamed(meta: AnnotateDocMeta | null | undefined): boolean {
  if (!meta) return false;
  if (meta.owned) return true;
  return Boolean(meta.label?.trim());
}

/** Meta for one entry, without touching its content. */
export function getAnnotateDocMeta(id: string): AnnotateDocMeta | null {
  return readIndex().find((entry) => entry.id === id) ?? null;
}

async function readContent(meta: AnnotateDocMeta): Promise<AnnotateDoc | null> {
  const content = await getContent<AnnotateContent>(meta.id);
  if (content?.board) {
    return {
      ...meta,
      source: typeof content.source === "string" ? content.source : "",
      board: content.board,
      footnotes: sanitizeFootnotes(content.footnotes),
      agent: Array.isArray(content.agent) ? content.agent : [],
      ...(Array.isArray(content.captures) ? { captures: content.captures } : {}),
      ...(content.padKind ? { padKind: content.padKind } : {}),
    };
  }
  // Written by the old build, still whole in the legacy key.
  const legacy = legacyEntry(meta.id);
  if (!legacy) return null;
  return {
    ...meta,
    source: typeof legacy.source === "string" ? legacy.source : "",
    board: legacy.board,
    footnotes: sanitizeFootnotes(legacy.footnotes),
    agent: Array.isArray(legacy.agent) ? legacy.agent : [],
  };
}

export async function getAnnotateDoc(id: string): Promise<AnnotateDoc | null> {
  const meta = getAnnotateDocMeta(id);
  return meta ? readContent(meta) : null;
}

/**
 * The scratch boards this set's marks point at.
 *
 * The pointer list, not the ink store: a board with strokes but no mark
 * pointing at it is a board somebody deleted, and syncing it is how a deleted
 * scratch board comes home from the other device. `null` when the set cannot
 * be read at all — the caller decides whether "unknown" should mean "sync it
 * anyway", and for handwriting it does.
 */
export async function localFootnoteBoardIds(
  docId: string,
): Promise<ReadonlySet<string> | null> {
  const doc = await getAnnotateDoc(docId).catch(() => null);
  if (!doc) return null;
  return new Set(whiteboardIdsOn(doc.footnotes ?? []));
}

/**
 * Every annotation set drawn over these exact bytes, newest first.
 *
 * Meta only and synchronous, like {@link listAnnotateDocs} — the caller is
 * deciding whether to show a chooser, which is a question about how many rows
 * there are, not about what is in them.
 */
export function listAnnotateDocsByHash(hash: string): AnnotateDocMeta[] {
  return readIndex()
    .filter((entry) => !entry.deletedAt && entry.hash === hash)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The most recent annotation set drawn over this exact markdown.
 *
 * Kept for the callers that want "reopen what I had" without asking. When more
 * than one set exists, prefer {@link listAnnotateDocsByHash} and let the reader
 * choose — this returns the newest and silently ignores the rest.
 */
export async function findAnnotateDocByHash(hash: string): Promise<AnnotateDoc | null> {
  const meta = listAnnotateDocsByHash(hash)[0];
  return meta ? readContent(meta) : null;
}

/**
 * An id for a set that has not been saved yet.
 *
 * Ink and snapshots are keyed by sidecar id, and both start writing well before
 * the first save — so the id has to exist from the moment the document opens,
 * not from the moment it lands in the library. Minting one does not reserve a
 * library slot: nothing is written until `saveAnnotateDoc` is called with it.
 */
export function freshAnnotateId(): string {
  return freshId(readIndex(), Date.now());
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
export function findStaleAnnotateDoc(name: string, hash: string): AnnotateDocMeta | null {
  return (
    readIndex().find((entry) => !entry.deletedAt && entry.name === name && entry.hash !== hash) ??
    null
  );
}

/** See the note on `freshId` in `whiteboardStore` — same millisecond, same trap. */
function freshId(library: readonly AnnotateDocMeta[], now: number): string {
  const base = `mdink-${now.toString(36)}`;
  if (!library.some((entry) => entry.id === base)) return base;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${base}-${suffix.toString(36)}`;
    if (!library.some((entry) => entry.id === candidate)) return candidate;
  }
}

const KEY_MIGRATION_FLAG = "whiteboard.annotate.keys.byId.v1";

/**
 * Move ink and snapshots from the file hash onto the sidecar id, once.
 *
 * Both used to be keyed by the hash of the annotated file, which is why only
 * one annotation set per file was ever possible — the second set would have
 * written over the first one's strokes. New writes go to `md:{id}` and
 * `annotate:{id}:{tier}`; this brings the existing rows across so nobody's ink
 * disappears on the upgrade.
 *
 * Rows whose hash is shared by more than one index entry are the ambiguous
 * case. That should not exist — the save path forbade it — but a library
 * carried across builds could hold one, so the ink goes to the most recently
 * updated set rather than being duplicated onto both or dropped. The others get
 * a clean start, which is the honest outcome: there is no way to tell whose
 * strokes those were.
 *
 * Best-effort and idempotent. A failure leaves the old rows in place and the
 * flag unset, so the next open tries again; the app reads id keys either way,
 * so the worst case is ink that has not arrived yet rather than ink that is
 * gone.
 */
export function annotateKeyMigrationPlan(
  index: readonly AnnotateDocMeta[],
): Array<{ from: string; to: string }> {
  const claimed = new Set<string>();
  const plan: Array<{ from: string; to: string }> = [];
  // Newest first, so when two sets share a hash the live one takes the ink.
  for (const meta of [...index].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (claimed.has(meta.hash)) continue;
    claimed.add(meta.hash);
    // A row whose hash already equals its id would rename a key onto itself.
    if (meta.hash === meta.id) continue;
    plan.push({ from: meta.hash, to: meta.id });
  }
  return plan;
}

export async function migrateAnnotateKeysToId(): Promise<number> {
  try {
    if (localStorage.getItem(KEY_MIGRATION_FLAG)) return 0;
  } catch {
    return 0;
  }
  let moved = 0;
  for (const { from, to } of annotateKeyMigrationPlan(readIndex())) {
    try {
      moved += await renameInkPages(annotateDocKey(from), annotateDocKey(to));
      moved += await renamePadSnapshots("annotate", from, to);
    } catch {
      // Leave the flag unset so the next mount picks up where this stopped.
      return moved;
    }
  }
  try {
    localStorage.setItem(KEY_MIGRATION_FLAG, "1");
  } catch {
    /* private browsing — the rename already happened, so a repeat is a no-op */
  }
  return moved;
}

/**
 * Save one entry.
 *
 * Async because content goes to IndexedDB, and that is the whole gain: a save
 * now writes *this* entry rather than re-serialising the library, and the
 * expensive half happens off the string path instead of under the nib.
 *
 * The index is written first and awaited last. If the content write fails, the
 * throw propagates and the index has already recorded an entry whose content is
 * missing — which reads back as `null` and is handled everywhere as "no saved
 * board". The other order loses the entry entirely on a failure that only
 * affected its payload.
 */
export async function saveAnnotateDoc(input: {
  id?: string;
  name: string;
  hash: string;
  docType?: DocType;
  /** Undefined keeps whatever the set is already called. */
  label?: string;
  /** Undefined keeps whatever the set already claims. */
  owned?: boolean;
  source: string;
  board: BoardBlob;
  footnotes?: readonly DocFootnote[];
  agent?: unknown[];
  /** Web pads only. Undefined keeps whatever history the pad already has. */
  captures?: readonly WebCapture[];
  /** Web pads only. Undefined keeps the reader's existing answer. */
  padKind?: WebPadKind;
}): Promise<AnnotateDoc> {
  const index = readIndex();
  const now = Date.now();
  /*
   * An annotation set is identified by its own id, never by the file it was
   * drawn over.
   *
   * This used to fall back to `index.find(entry => entry.hash === input.hash)`,
   * which made a second annotation set on one PDF impossible: the second save
   * found the first set's row and overwrote it. A hash answers "are these the
   * same bytes"; it was never an answer to "which of my sets is this".
   *
   * Callers that have no id yet pass none and get a fresh one — one file can
   * now carry as many sets as the library holds.
   */
  const existing = input.id ? index.find((entry) => entry.id === input.id) ?? null : null;
  const id = input.id ?? freshId(index.filter((entry) => !entry.deletedAt), now);
  if (!existing && liveAnnotateCount() >= ANNOTATE_LIBRARY_LIMIT) {
    throw new AnnotateLibraryFullError(
      `At most ${ANNOTATE_LIBRARY_LIMIT} annotated documents — delete one to keep another.`,
    );
  }
  // Undefined means "this caller does not track footnotes / the thread", not
  // "there are none" — an autosave that omits them must not wipe the set the
  // reading session built up.
  const prior =
    input.footnotes && Array.isArray(input.agent)
      ? null
      : await getContent<AnnotateContent>(id);
  const footnotes = input.footnotes ? [...input.footnotes] : prior?.footnotes ?? [];
  const agent = Array.isArray(input.agent) ? input.agent : prior?.agent ?? [];
  /*
   * Same contract as footnotes: undefined means "this caller does not track
   * captures", not "there are none". An autosave that omits them must not drop
   * the older page a stranded mark is still standing on.
   */
  const history = await (input.captures || input.padKind
    ? prior ?? getContent<AnnotateContent>(id)
    : Promise.resolve(prior));
  const captures = input.captures ? [...input.captures] : history?.captures;
  const padKind = input.padKind ?? history?.padKind;
  const label = input.label?.trim() || existing?.label;
  const owned = input.owned ?? existing?.owned;
  const meta: AnnotateDocMeta = {
    id,
    name: input.name.trim() || existing?.name || "Untitled.md",
    hash: input.hash,
    docType: input.docType ?? existing?.docType ?? "markdown",
    updatedAt: now,
    ...(label ? { label } : {}),
    ...(owned ? { owned: true } : {}),
    ...(existing?.locked ? { locked: true } : {}),
    syncSeq: existing?.syncSeq ?? 0,
    lastTouch: now,
    ...(existing?.hubAckUpdatedAt != null ? { hubAckUpdatedAt: existing.hubAckUpdatedAt } : {}),
  };
  writeIndex([meta, ...index.filter((entry) => entry.id !== id)]);
  await putContent(id, {
    source: input.source,
    board: input.board,
    footnotes,
    agent,
    ...(captures && captures.length > 0 ? { captures } : {}),
    ...(padKind ? { padKind } : {}),
  } satisfies AnnotateContent);
  return {
    ...meta,
    source: input.source,
    board: input.board,
    footnotes,
    agent,
    ...(captures && captures.length > 0 ? { captures } : {}),
    ...(padKind ? { padKind } : {}),
  };
}

export function markAnnotateHubAck(id: string, updatedAt: number): void {
  const existing = readIndex().find((entry) => entry.id === id);
  if (!existing) return;
  writeIndex([
    { ...existing, hubAckUpdatedAt: updatedAt },
    ...readIndex().filter((entry) => entry.id !== id),
  ]);
}

export function setAnnotateDocLocked(id: string, locked: boolean): void {
  const index = readIndex();
  const existing = index.find((entry) => entry.id === id);
  if (!existing) return;
  const next: AnnotateDocMeta = { ...existing };
  if (locked) next.locked = true;
  else delete next.locked;
  writeIndex([next, ...index.filter((entry) => entry.id !== id)]);
}

export async function trashAnnotateDoc(id: string, now = Date.now()): Promise<number | null> {
  const existing = readIndex().find((entry) => entry.id === id);
  if (!existing || existing.locked) return null;
  const seq = (existing.syncSeq ?? 0) + 1;
  const next: AnnotateDocMeta = {
    ...existing,
    deletedAt: now,
    syncSeq: seq,
    deleteAcked: false,
    lastTouch: now,
  };
  writeIndex([next, ...readIndex().filter((entry) => entry.id !== id)]);
  return seq;
}

export function markAnnotateDeleteAcked(id: string, acked: boolean): void {
  const existing = readIndex().find((entry) => entry.id === id);
  if (!existing?.deletedAt) return;
  writeIndex([
    { ...existing, deleteAcked: acked },
    ...readIndex().filter((entry) => entry.id !== id),
  ]);
}

export async function restoreAnnotateFromTrash(id: string): Promise<AnnotateDoc | null> {
  const existing = readIndex().find((entry) => entry.id === id);
  if (!existing?.deletedAt) return null;
  if (liveAnnotateCount() >= ANNOTATE_LIBRARY_LIMIT) {
    throw new AnnotateLibraryFullError(
      `At most ${ANNOTATE_LIBRARY_LIMIT} annotated documents — delete one to restore another.`,
    );
  }
  const seq = (existing.syncSeq ?? 0) + 1;
  const next: AnnotateDocMeta = { ...existing, syncSeq: seq, lastTouch: Date.now() };
  delete next.deletedAt;
  delete next.deleteAcked;
  writeIndex([next, ...readIndex().filter((entry) => entry.id !== id)]);
  return readContent(next);
}

export async function sweepAnnotateTrash(now = Date.now()): Promise<string[]> {
  const expired = readIndex().filter(
    (entry) =>
      entry.deletedAt &&
      entry.deleteAcked &&
      now - entry.deletedAt >= ANNOTATE_TRASH_TTL_MS,
  );
  const ids: string[] = [];
  for (const entry of expired) {
    await deleteAnnotateDoc(entry.id);
    ids.push(entry.id);
  }
  return ids;
}

export async function deleteAnnotateDoc(id: string): Promise<void> {
  const index = readIndex();
  const going = index.find((entry) => entry.id === id) ?? null;
  if (going?.locked) return;
  const kept = index.filter((entry) => entry.id !== id);
  writeIndex(kept);
  await deleteContent(id);
  if (going) {
    void deletePadSnapshots("annotate", going.id).catch(() => {});
    void deleteInkPages(annotateDocKey(going.id)).catch(() => {});
    void sweepFootnoteWhiteboards(going.id).catch(() => {});
    /*
     * The graph loses this node's edges with it.
     *
     * Both directions: an edge whose *target* is gone would otherwise draw a
     * line to a node the atlas cannot name, which reads as data loss rather
     * than as a deletion the reader asked for. Imported dynamically so the
     * store does not pull the links module into every caller.
     */
    void import("./noteLinks")
      .then((links) =>
        Promise.all([
          links.deleteEdgesFor({ type: "annotate", id: going.id }),
          links.deleteEdgesFor({ type: "web", id: going.id }),
        ]),
      )
      .catch(() => {});
  }
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
 * `restoreWhiteboardNotebook` for why both of those would be wrong here.
 */
export async function restoreAnnotateDoc(entry: AnnotateDoc): Promise<void> {
  const { source, board, footnotes, agent, ...meta } = entry;
  writeIndex([meta, ...readIndex().filter((existing) => existing.id !== entry.id)]);
  await putContent(entry.id, {
    source,
    board,
    footnotes: footnotes ?? [],
    agent: Array.isArray(agent) ? agent : [],
  } satisfies AnnotateContent);
}
