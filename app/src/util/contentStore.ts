/**
 * Where the heavy half of a library entry lives.
 *
 * An entry is a small description — id, name, hash, when it was touched — and a
 * large payload: the board, the ink, the images, and for markdown and code a
 * copy of the whole source file. Both halves used to sit in one `localStorage`
 * key per library, and that arrangement had three separate ways of failing:
 *
 *   - **It could not fit.** `CODE_SOURCE_MAX_CHARS` is 1.5M and the library
 *     holds 30 entries, so the per-file guard alone permitted 90 MB of UTF-16
 *     against a ~5 MB quota. Ink, images and coach attachments were on top of
 *     that.
 *   - **It rewrote everything to change anything.** One entry's autosave
 *     re-serialised all thirty, every three seconds, on the main thread. That
 *     is the cost `CHANGELOG.md` records as the stroke stopping mid-letter.
 *   - **Listing the library parsed all of it.** Rendering thirty file names
 *     meant `JSON.parse` over every board in the store.
 *
 * Both halves and their authored versions now commit in one IndexedDB
 * transaction. A small metadata cache keeps library rendering synchronous.
 *
 * **Falling back is not optional.** IndexedDB is absent or refuses to open in
 * Safari private browsing, in WebViews with storage switched off, and while
 * another tab holds an older version of the database. When that happens content
 * and its metadata/version token go into one fallback envelope. Promotion
 * compares that token and the durable version before publishing it.
 */

import { run, withStore, STORE_CONTENT } from "./idb";
import {
  fallbackBookIdentity, getCachedBookMeta, hasFallbackContent, listFallbackContentKeys, mutateLocalBook,
  promoteFallbackContent, readFallbackContent, type LocalBookEdit,
} from "./localBookStore";
import { setStorageItem } from "./storageQuota";
import { mergeAgentMessages } from "../modes/coachSessions";
import { pruneDeletedThreadLinks } from "./threadLinks";
import type { DocFootnote } from "./docFootnotes";
import { artifactCatalogFields, type ArtifactCatalog, type ArtifactParent } from "./padArtifacts";
import { ArtifactEditConflict, editArtifactCatalog, requireArtifactCatalogTransition, type ArtifactCatalogEdit } from "./artifactCatalogEdits";

/** Per-entry spill key. Per-entry, not per-library, so a fallback save is still small. */
function spillKey(id: string): string {
  return `whiteboard.content.v1.${id}`;
}

const SPILL_PREFIX = "whiteboard.content.v1.";

/**
 * Set while entries are living in the fallback store.
 *
 * Durable on purpose: the condition outlives a reload — the tab blocking the
 * database upgrade is still open, private browsing is still on — and a flag
 * held only in memory would let a restart present a degraded store as a
 * healthy one. Cleared the moment a repair finds nothing left to move.
 */
const SPILL_ONLY_KEY = "whiteboard.storage.spillOnly";

/** Raised when the answer to {@link contentSpillOnly} changes. */
export const SPILL_STATE_EVENT = "lc-content-spill";

/** True while at least one entry's content is in the fallback store. */
export function contentSpillOnly(): boolean {
  try {
    return listFallbackContentKeys().length > 0 || localStorage.getItem(SPILL_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

function noteSpillOnly(on: boolean): void {
  if (contentSpillOnly() === on) return;
  try {
    // Raw, not `setStorageItem`: a five-byte flag saying the store is full
    // must not be the write that throws for being unable to fit.
    if (on) localStorage.setItem(SPILL_ONLY_KEY, "1");
    else localStorage.removeItem(SPILL_ONLY_KEY);
  } catch {
    return;
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SPILL_STATE_EVENT, { detail: { spillOnly: on } }));
}

/**
 * Which backend the last write used.
 *
 * Not a cache of "is IndexedDB available" — it is re-asked on every save,
 * because the answer changes: the tab blocking an upgrade closes, private
 * browsing ends, the device frees space. `false` here only means the previous
 * attempt spilled, which is what tells the next one to try promoting.
 */
let spilled = false;

/** Ids sitting in `localStorage` waiting to be moved across. */
function spilledIds(): string[] {
  const ids: string[] = [...listFallbackContentKeys()];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(SPILL_PREFIX)) {
        try {
          const value = JSON.parse(localStorage.getItem(key) ?? "null") as { v?: number; owner?: unknown } | null;
          if (value?.v === 2 && value.owner) continue;
        } catch { /* Retain malformed legacy spills for the repair failure. */ }
        const id = key.slice(SPILL_PREFIX.length);
        if (!ids.includes(id)) ids.push(id);
      }
    }
  } catch {
    /* a store that will not even enumerate has nothing to promote */
  }
  return ids;
}

/**
 * Move anything that spilled back into IndexedDB.
 *
 * Best-effort and silent. Called after a successful write, when we have just
 * proven the database opens; a failure here leaves the spill exactly where it
 * was, which is the state it was already surviving in.
 */
async function promoteSpilled(): Promise<number> {
  let promoted = 0;
  for (const id of spilledIds()) {
    try {
      if (fallbackBookIdentity(id)) {
        if (await promoteFallbackContent(id)) promoted += 1;
        continue;
      }
      const raw = localStorage.getItem(spillKey(id));
      if (raw == null) continue;
      const before = await run<unknown>(STORE_CONTENT, "readonly", store => store.get(id));
      if (before !== undefined && JSON.stringify(before) !== raw) throw new Error("Local copies differ; both were kept.");
      await run(STORE_CONTENT, "readwrite", (store) => store.put(JSON.parse(raw), id));
      if (localStorage.getItem(spillKey(id)) === raw) localStorage.removeItem(spillKey(id));
      promoted += 1;
    } catch {
      // Stop at the first failure rather than grinding through the rest: they
      // will all fail the same way, and the next save tries again.
      spilled = spilledIds().length > 0;
      noteSpillOnly(spilled);
      return promoted;
    }
  }
  spilled = spilledIds().length > 0;
  noteSpillOnly(spilled);
  return promoted;
}

/** Has this session already swept? The condition does not change on its own. */
let repaired = false;

/**
 * Move everything that spilled back into IndexedDB, once per launch.
 *
 * Promoting only after a successful write meant a long outage could end and
 * nothing would come back until the reader happened to save the *right* entry:
 * a spilled footnote board sat in `localStorage` — against a ~5 MB origin
 * quota, shared with every other spill — for as long as nobody edited it, and
 * a reader who had moved on to another document never touched it again.
 *
 * Best-effort and silent, like the promote it wraps. A database that still
 * refuses leaves every spill exactly where it was, which is the state it was
 * already surviving in, and the flag stays up so the reader is told.
 */
export async function repairContentStore(
  opts: { force?: boolean } = {},
): Promise<{ promoted: number; remaining: number }> {
  if (repaired && !opts.force) return { promoted: 0, remaining: spilledIds().length };
  repaired = true;
  if (spilledIds().length === 0) {
    noteSpillOnly(false);
    return { promoted: 0, remaining: 0 };
  }
  const promoted = await promoteSpilled();
  return { promoted, remaining: spilledIds().length };
}

export function resetContentRepairForTests(): void {
  repaired = false;
  spilled = false;
}

/**
 * Store one entry's content.
 *
 * Throws only when *both* backends refuse — at which point the caller has a
 * genuine out-of-space condition to report, and `StorageFullError` from the
 * spill is the more useful of the two failures to hand on.
 */
function contentOwner(id: string): ArtifactParent | null {
  const fallback = fallbackBookIdentity(id);
  if (fallback) return fallback;
  const footnote = /^fnwb:([^:]+):[^:]+$/.exec(id);
  if (footnote) return { kind: "annotate", id: footnote[1] };
  if (getCachedBookMeta("annotate", id)) return { kind: "annotate", id };
  if (getCachedBookMeta("whiteboard", id)) return { kind: "whiteboard", id };
  return null;
}

export async function putContent(id: string, content: unknown, parent?: ArtifactParent): Promise<void> {
  const owner = parent ?? contentOwner(id);
  if (owner) {
    await mutateLocalBook(owner, { contentKey: id }, ctx => {
      const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
      ctx.setContent(object(ctx.content) && object(content) ? { ...ctx.content, ...content } : content);
    });
    noteSpillOnly(listFallbackContentKeys().length > 0);
    return;
  }
  try {
    await run(STORE_CONTENT, "readwrite", (store) => store.put(content, id));
    try {
      localStorage.removeItem(spillKey(id));
    } catch {
      /* spill may already be gone */
    }
    /*
     * The database is open and writing, so anything stranded can come across.
     *
     * The durable flag as well as the in-memory bit: after a reload the bit is
     * false while the spill keys are still there, and a device that recovered
     * overnight would otherwise wait for a *second* successful save before
     * anything moved.
     */
    if (spilled || contentSpillOnly()) await promoteSpilled();
    return;
  } catch {
    // Fall through to the spill. Not an error the caller can act on — a device
    // where IndexedDB is unavailable still works — but the reader is told
    // once, quietly, that the smaller store is carrying their work.
  }
  setStorageItem(spillKey(id), JSON.stringify(content));
  spilled = true;
  // The write landed, in the smaller of the two stores. Saying so is the
  // difference between a reader who frees space and one who finds out when
  // the fallback fills up too.
  noteSpillOnly(true);
}

/**
 * Parent saves preserve an omitted catalog INSIDE the content transaction.
 * A cached index hint or a prior async read is not sufficient: another editor
 * can attach content between that read and this write.
 */
export interface ParentWriteOptions<T, M> {
  expectedCatalogRevision?: string | null;
  catalogOnly?: boolean;
  agentOnly?: boolean;
  assertLive?: () => void;
  allowCatalogReplacement?: boolean;
  authored?: boolean;
  requireLiveMetadata?: boolean;
  metadata?: (current: M | null, saved: T) => M | null;
  editState?: (ctx: LocalBookEdit) => void;
}

/** Metadata, payload and tracking are accepted together from authoritative reads. */
export async function putParentRecord<T extends { artifacts?: ArtifactCatalog }, M extends { id: string } = { id: string }>(
  parent: ArtifactParent, content: T, opts: ParentWriteOptions<T, M> = {},
): Promise<{ content: T; metadata: M | null }> {
  artifactCatalogFields(content.artifacts, parent);
  const guarded = opts.expectedCatalogRevision !== undefined;
  if (guarded && contentSpillOnly()) throw new Error("Repair local storage before editing attachments.");
  const merge = (previous: T | undefined): T => {
    if (opts.agentOnly) {
      if (!previous) throw new Error("The chat's parent was closed or removed during sync.");
      const prior = previous as Record<string, unknown>, incoming = content as Record<string, unknown>;
      const agent = mergeAgentMessages(Array.isArray(prior.agent) ? prior.agent : [],
        Array.isArray(incoming.agent) ? incoming.agent : []);
      return { ...previous, agent, ...(Array.isArray(prior.footnotes)
        ? {footnotes: pruneDeletedThreadLinks(prior.footnotes as DocFootnote[], agent)} : {}) };
    }
    if (guarded && (previous?.artifacts?.revision ?? null) !== opts.expectedCatalogRevision) throw new ArtifactEditConflict();
    if (!guarded && !opts.allowCatalogReplacement && content.artifacts && previous?.artifacts &&
        content.artifacts.revision !== previous.artifacts.revision) throw new ArtifactEditConflict();
    if (opts.catalogOnly && !previous) throw new Error("Parent content is missing; attachment was not published.");
    let artifacts = requireArtifactCatalogTransition(previous?.artifacts, content.artifacts, parent);
    if (!opts.catalogOnly && !opts.allowCatalogReplacement && artifacts) {
      const oldRecord = previous as Record<string, unknown> | undefined;
      const newRecord = content as Record<string, unknown>;
      for (const [field, kind] of [["footnotes", "footnote"], ["agent", "thread"]] as const) {
        const oldRows = oldRecord?.[field], newRows = newRecord[field];
        if (!Array.isArray(oldRows) || !Array.isArray(newRows)) continue;
        const kept = new Set(newRows.map(row => row?.id));
        for (const row of oldRows) if (typeof row?.id === "string" && !kept.has(row.id)) {
          artifacts = editArtifactCatalog(artifacts, parent, artifacts.revision, { type: "detach",
            association: kind === "footnote" ? { kind, footnoteId: row.id } : { kind, rootId: row.id } });
        }
      }
    }
    const result = { ...previous, ...(opts.catalogOnly ? {} : content), ...(artifacts ? { artifacts } : {}) } as T;
    const oldRows = (previous as Record<string, unknown> | undefined)?.agent;
    const nextRows = (result as Record<string, unknown>).agent;
    if (!opts.catalogOnly && Array.isArray(oldRows)) {
      (result as Record<string, unknown>).agent = mergeAgentMessages(oldRows, Array.isArray(nextRows) ? nextRows : [], false);
    }
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.footnotes) && Array.isArray(record.agent)) {
      record.footnotes = pruneDeletedThreadLinks(record.footnotes as DocFootnote[], record.agent);
    }
    return result;
  };
  return mutateLocalBook(parent, { authored: opts.authored !== false, requireIdb: guarded || opts.catalogOnly }, ctx => {
    opts.assertLive?.();
    if (opts.requireLiveMetadata && !ctx.metadata
      || ctx.metadata?.deletedAt !== undefined && (guarded || opts.catalogOnly || opts.agentOnly)) {
      throw new Error("The parent was removed; content was not published.");
    }
    const saved = merge(ctx.content as T | undefined ?? undefined);
    ctx.setContent(saved);
    let metadata = ctx.metadata as M | null;
    if (opts.metadata) metadata = opts.metadata(metadata, saved);
    else if (metadata && saved.artifacts) metadata = { ...metadata, artifactRevision: saved.artifacts.revision,
      ...(opts.catalogOnly ? { updatedAt: Math.max(Date.now(), Number(ctx.metadata?.updatedAt ?? 0) + 1) } : {}) };
    if (opts.metadata || metadata !== ctx.metadata) ctx.setMetadata(metadata ? { ...metadata, kind: parent.kind } : null);
    opts.editState?.(ctx);
    return { content: saved, metadata };
  });
}

export async function putParentContent<T extends { artifacts?: ArtifactCatalog }>(
  parent: ArtifactParent, content: T, opts: ParentWriteOptions<T, { id: string }> = {},
): Promise<T> {
  return (await putParentRecord(parent, content, opts)).content;
}

/** Dependency preflight + atomic catalog-only CAS; caller updates its tiny index. */
export async function editParentContentArtifacts(
  parent: ArtifactParent, expectedCatalogRevision: string | null,
  edit: ArtifactCatalogEdit, assertLive: () => void,
): Promise<ArtifactCatalog> {
  assertLive();
  const requireLiveMetadata = Boolean(getCachedBookMeta(parent.kind, parent.id));
  const previous = await getContent<{ artifacts?: ArtifactCatalog }>(parent.id);
  if (!previous) throw new Error("Save the parent before attaching content.");
  const next = editArtifactCatalog(previous.artifacts, parent, expectedCatalogRevision, edit);
  const { downloadArtifactAssets } = await import("./artifactAssetSync");
  await downloadArtifactAssets(undefined, next);
  const stored = await putParentContent(parent, { artifacts: next }, {
    expectedCatalogRevision, catalogOnly: true, assertLive, requireLiveMetadata,
  });
  return stored.artifacts!;
}

/** Read one entry's content back, from wherever it ended up. */
export async function getContent<T>(id: string): Promise<T | null> {
  const fallback = readFallbackContent<T>(id);
  if (fallback !== null || hasFallbackContent(id)) return fallback;
  try {
    const raw = localStorage.getItem(spillKey(id));
    if (raw != null) {
      try {
        const value: unknown = JSON.parse(raw);
        // A metadata-only envelope does not replace a readable durable body.
        if (!(value && typeof value === "object" && "v" in value && value.v === 2 && "owner" in value)) return value as T;
      } catch {
        /* corrupt spill — fall through to IndexedDB */
      }
    }
  } catch {
    /* localStorage missing */
  }
  try {
    const value = await run<T | undefined>(STORE_CONTENT, "readonly", (store) =>
      store.get(id),
    );
    if (value !== undefined) return value;
  } catch {
    /* nothing in IndexedDB either */
  }
  return null;
}

/** Remove an entry's content from both backends — either may hold it. */
export async function deleteContent(id: string): Promise<void> {
  const owner = contentOwner(id);
  if (owner) {
    await mutateLocalBook(owner, { contentKey: id }, ctx => ctx.setContent(null));
    noteSpillOnly(listFallbackContentKeys().length > 0);
    return;
  }
  try {
    await run(STORE_CONTENT, "readwrite", (store) => store.delete(id));
  } catch {
    /* nothing there, or nothing open — the spill removal below still matters */
  }
  try {
    localStorage.removeItem(spillKey(id));
  } catch {
    /* best-effort */
  }
  // Deleting the last spilled entry is as good a way out of the fallback as
  // promoting it, and the notice has to come down either way.
  if (spilledIds().length === 0) noteSpillOnly(false);
}

/**
 * Drop every content key that starts with `prefix`.
 *
 * Used to sweep footnote-owned boards (`fnwb:{docId}:`) when an annotation
 * set is deleted. Walks IndexedDB by cursor and the spill keys by prefix so
 * an orphan cannot survive on only one backend.
 */
export async function deleteContentByPrefix(prefix: string): Promise<void> {
  if (!prefix) return;
  const footnoteOwner = /^fnwb:([^:]+):$/.exec(prefix)?.[1];
  if (footnoteOwner) {
    await mutateLocalBook({ kind: "annotate", id: footnoteOwner }, {}, ctx => {
      if (!ctx.tx) return;
      ctx.tx.objectStore(STORE_CONTENT).delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      ctx.setState({ ...ctx.state, changeSeq: ctx.seq });
    });
    // Each captured child is removed through the same tracked writer. Keep
    // other writer branches and newly arrived replacements readable.
    for (const key of listFallbackContentKeys().filter(key => key.startsWith(prefix))) await deleteContent(key);
    return;
  }
  try {
    await withStore(STORE_CONTENT, "readwrite", (store) => {
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
    });
  } catch {
    /* private browsing / missing store */
  }
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(`${SPILL_PREFIX}${prefix}`)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* best-effort */
  }
}

/**
 * Read several entries at once, for a migration or a bulk export.
 *
 * Returns a map rather than an array so a missing entry is visibly missing
 * instead of shifting everything after it.
 */
export async function getManyContent<T>(ids: readonly string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  for (const id of ids) {
    const value = await getContent<T>(id);
    if (value != null) out.set(id, value);
  }
  return out;
}
