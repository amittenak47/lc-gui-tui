/** Durable book edits and their versions share one transaction. */
import { abortTransaction, openDb, run, StorageUnavailableError, withTransaction, STORE_BOOK_META, STORE_CONTENT,
  STORE_PROBLEM_BOARDS, STORE_SYNC_STATE, STORE_SYNC_RECOVERY } from "./idb";
import { allocateChangeSeqRange, bookMetaKey, seedSyncState, syncStateKey,
  type BookIdentity, type BookMeta, type PadKind, type SyncState } from "./syncState";
import { bookWriterIdentity, hasBookLocks, newBookToken, withBookWrite } from "./bookCoordinator";
import { setStorageItem } from "./storageQuota";

const SPILL_PREFIX = "whiteboard.content.v1.";
const BRANCH_SEPARATOR = ".writer.";
const INDEX_KEYS: Record<"annotate" | "whiteboard", string[]> = {
  annotate: ["whiteboard.annotate.index.v1", "lc.md-ink.index.v1"],
  whiteboard: ["whiteboard.notebook.index.v1", "lc.scratchpad.index.v1"],
};
const LIBRARY_EVENT: Record<PadKind, string> = { annotate: "lc-annotate-library", whiteboard: "lc-whiteboard-library", problem: "lc-problem-library" };
const cache = new Map<string, BookMeta>();
const cachedStates = new Map<string, SyncState>();
let metadataReady = false;
let cacheStorage: Storage | undefined;
let broadcast: BroadcastChannel | null = null;
let installingBroadcast = false;

export class LocalBookConflictError extends Error {
  constructor(message = "Saved local copies differ. Choose a copy before syncing; all copies were kept.") { super(message); this.name = "LocalBookConflictError"; }
}
export interface FallbackBookEnvelope {
  v: 2;
  owner: BookIdentity;
  key: string;
  token: string;
  writerId: string;
  payload: unknown;
  metadata: BookMeta | null;
  state: SyncState;
  baseChangeSeq: number | null;
  /** False means a metadata-only spill could not read its durable payload. */
  payloadPresent?: boolean;
}
interface FallbackEntry { storageKey: string; raw: string; key: string; envelope: FallbackBookEnvelope | null; payload: unknown }

function storage(): Storage | undefined { return typeof localStorage === "undefined" ? undefined : localStorage; }
function ensureCacheScope(): void {
  const current = storage();
  if (cacheStorage !== current) { cacheStorage = current; metadataReady = false; cache.clear(); cachedStates.clear(); }
}
function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function validOwner(value: unknown): value is BookIdentity {
  return plain(value) && ["annotate", "whiteboard", "problem"].includes(String(value.kind)) && typeof value.id === "string" && value.id.length > 0;
}
function decodeFallback(storageKey: string, raw: string): FallbackEntry {
  const value: unknown = JSON.parse(raw);
  if (plain(value) && value.v === 2 && validOwner(value.owner) && typeof value.key === "string"
      && typeof value.token === "string" && typeof value.writerId === "string" && plain(value.state)) {
    const envelope = value as unknown as FallbackBookEnvelope;
    return { storageKey, raw, key: envelope.key, envelope, payload: envelope.payload };
  }
  if (plain(value) && value.v === 2 && "owner" in value) throw new LocalBookConflictError("A saved fallback record is unreadable. Its original value was kept.");
  return { storageKey, raw, key: storageKey.slice(SPILL_PREFIX.length), envelope: null, payload: value };
}
function allFallbackEntries(): FallbackEntry[] {
  const target = storage(); if (!target) return [];
  const entries: FallbackEntry[] = [];
  for (let index = 0; index < target.length; index++) {
    const key = target.key(index); if (!key?.startsWith(SPILL_PREFIX)) continue;
    const raw = target.getItem(key); if (raw !== null) entries.push(decodeFallback(key, raw));
  }
  return entries;
}
function fallbackSignature(entry: FallbackEntry): string {
  return JSON.stringify({ payload: entry.payload, payloadPresent: entry.envelope?.payloadPresent !== false,
    metadata: entry.envelope?.metadata ?? null, lifecycle: entry.envelope?.state.lifecycle ?? null });
}
function selectFallback(key: string, forPromotion = false): FallbackEntry | null {
  const entries = allFallbackEntries().filter(entry => entry.key === key);
  if (entries.length === 0) return null;
  const own = entries.find(entry => entry.envelope?.writerId === bookWriterIdentity());
  if (own && !forPromotion) return own;
  const first = own ?? entries[0]!;
  if (entries.some(entry => fallbackSignature(entry) !== fallbackSignature(first))) throw new LocalBookConflictError();
  return first;
}

export function listFallbackContentKeys(): string[] { return [...new Set(allFallbackEntries().map(entry => entry.key))]; }
export function readFallbackContent<T>(key: string): T | null {
  const entry = selectFallback(key);
  return entry?.envelope?.payloadPresent === false ? null : entry?.payload as T | null ?? null;
}
export function hasFallbackContent(key: string): boolean {
  const selected = selectFallback(key);
  return selected !== null && selected.envelope?.payloadPresent !== false;
}
export function listBookFallbacks(): FallbackBookEnvelope[] { return allFallbackEntries().flatMap(entry => entry.envelope ? [entry.envelope] : []); }
export function fallbackBookIdentity(key: string): BookIdentity | null {
  const disclosed = allFallbackEntries().find(entry => entry.key === key && entry.envelope)?.envelope?.owner;
  if (disclosed) return disclosed;
  if (key.startsWith("fnwb:")) {
    const delimiter = key.indexOf(":", 5);
    if (delimiter > 5 && delimiter < key.length - 1) return { kind: "annotate", id: key.slice(5, delimiter) };
  }
  for (const kind of ["annotate", "whiteboard", "problem"] as const) {
    if (getCachedBookMeta(kind, key)) return { kind, id: key };
  }
  return null;
}

function legacyMetadata(kind: PadKind): BookMeta[] {
  if (kind === "problem") return [];
  const target = storage(); if (!target) return [];
  for (const key of INDEX_KEYS[kind]) {
    const raw = target.getItem(key); if (!raw) continue;
    try {
      const rows: unknown = JSON.parse(raw);
      if (Array.isArray(rows)) return rows.filter(row => plain(row) && typeof row.id === "string")
        .map(row => ({ ...row, kind } as BookMeta));
    } catch { /* The migration gate reports malformed sources before mounting. */ }
  }
  return [];
}

export function getCachedBookMetadata<T extends { id: string } = BookMeta>(kind: PadKind, legacyRows?: readonly T[]): T[] {
  ensureCacheScope();
  const result = new Map<string, BookMeta>();
  if (!metadataReady) for (const row of legacyRows ?? legacyMetadata(kind)) result.set(row.id, { ...row, kind } as BookMeta);
  for (const meta of cache.values()) if (meta.kind === kind) result.set(meta.id, meta);
  // The current writer's saved envelope takes precedence until safe promotion.
  const parentKeys = new Set(allFallbackEntries().filter(entry => entry.envelope?.owner.kind === kind && entry.key === entry.envelope.owner.id).map(entry => entry.key));
  for (const key of parentKeys) {
    const envelope = selectFallback(key)?.envelope;
    if (envelope?.metadata) result.set(envelope.metadata.id, envelope.metadata);
    else if (envelope) result.delete(envelope.owner.id);
  }
  return [...result.values()].sort((a, b) => Number(b.lastTouch ?? b.updatedAt ?? 0) - Number(a.lastTouch ?? a.updatedAt ?? 0)) as unknown as T[];
}
export function getCachedBookMeta<T extends { id: string } = BookMeta>(kind: PadKind, id: string, legacyRows?: readonly T[]): T | null {
  return getCachedBookMetadata<T>(kind, legacyRows).find(meta => meta.id === id) ?? null;
}
function cacheMeta(meta: BookMeta | null, owner: BookIdentity): void {
  ensureCacheScope();
  const key = bookMetaKey(owner.kind, owner.id);
  if (meta) cache.set(key, meta); else cache.delete(key);
}
function updateDerivedIndexes(): void {
  if (!metadataReady) return;
  const target = storage(); if (!target) return;
  for (const kind of ["annotate", "whiteboard"] as const) {
    try {
      const rows = [...cache.values()].filter(meta => meta.kind === kind)
        .sort((a, b) => Number(b.lastTouch ?? b.updatedAt ?? 0) - Number(a.lastTouch ?? a.updatedAt ?? 0))
        .map(({ kind: _kind, ...meta }) => meta);
      target.setItem(INDEX_KEYS[kind][0]!, JSON.stringify(rows));
    } catch { /* A cache failure cannot hide committed authoritative metadata. */ }
  }
}
function emitMetadata(owner?: BookIdentity, send = true): void {
  if (typeof window !== "undefined") {
    if (owner) window.dispatchEvent(new Event(LIBRARY_EVENT[owner.kind]));
    else for (const name of Object.values(LIBRARY_EVENT)) window.dispatchEvent(new Event(name));
  }
  if (send) broadcast?.postMessage({ generation: newBookToken(), owner });
}
function installBroadcast(): void {
  if (installingBroadcast || typeof BroadcastChannel === "undefined" || typeof window === "undefined") return;
  installingBroadcast = true;
  broadcast = new BroadcastChannel("whiteboard.book-metadata.v8");
  broadcast.onmessage = () => { void refreshBookMetadata(false).catch(() => {}); };
}
export async function hydrateBookMetadata(): Promise<void> {
  try { await refreshBookMetadata(false); }
  catch (cause) {
    if (!(cause instanceof StorageUnavailableError)) throw cause;
    ensureCacheScope();
    // Legacy indexes and saved envelopes remain authoritative without IDB.
    for (const kind of ["annotate", "whiteboard", "problem"] as const) getCachedBookMetadata(kind);
  }
  installBroadcast();
}
export async function refreshBookMetadata(send = true): Promise<void> {
  ensureCacheScope();
  const { rows, states } = await withTransaction<{ rows: BookMeta[]; states: SyncState[] }>([STORE_BOOK_META, STORE_SYNC_STATE], "readonly", (tx, setResult) => {
    const metadata = tx.objectStore(STORE_BOOK_META).getAll();
    const tracking = tx.objectStore(STORE_SYNC_STATE).getAll();
    let pending = 2;
    const ready = () => { if (--pending === 0) setResult({ rows: metadata.result as BookMeta[], states: tracking.result as SyncState[] }); };
    metadata.onsuccess = ready; tracking.onsuccess = ready;
  });
  cache.clear(); for (const row of rows) if (validOwner(row)) cache.set(bookMetaKey(row.kind, row.id), row);
  cachedStates.clear(); for (const state of states) if (validOwner(state)) cachedStates.set(syncStateKey(state.kind, state.id), state);
  metadataReady = true; updateDerivedIndexes(); emitMetadata(undefined, send);
}
export async function notifyBookMetadataChanged(kind: PadKind, id: string): Promise<void> {
  const meta = await run<BookMeta | undefined>(STORE_BOOK_META, "readonly", store => store.get(bookMetaKey(kind, id)));
  cacheMeta(meta ?? null, { kind, id }); updateDerivedIndexes(); emitMetadata({ kind, id });
}

export interface LocalBookEdit {
  metadata: BookMeta | null;
  content: unknown | null;
  state: SyncState;
  tx: IDBTransaction | null;
  seq: number;
  setMetadata(meta: BookMeta | null): void;
  setContent(content: unknown): void;
  setState(state: SyncState): void;
  markLifecycle(action: "delete" | "restore", seq: number, baseBookRev?: number | null, goneSeq?: number | null): void;
}
export interface LocalBookEditOptions {
  contentKey?: string;
  contentStore?: string;
  authored?: boolean;
  requireIdb?: boolean;
  extraStores?: readonly string[];
  expectedFallback?: { storageKey: string; raw: string };
}

/** The synchronous edit function is shared by IDB and one-value fallback. */
export function mutateLocalBook<T>(owner: BookIdentity, options: LocalBookEditOptions, edit: (ctx: LocalBookEdit) => T): Promise<T> {
  return withBookWrite(owner.kind, owner.id, async () => {
    ensureCacheScope();
    const contentKey = options.contentKey ?? owner.id;
    const contentStore = options.contentStore ?? (owner.kind === "problem" ? STORE_PROBLEM_BOARDS : STORE_CONTENT);
    const authored = options.authored !== false;
    if (options.expectedFallback && storage()?.getItem(options.expectedFallback.storageKey) !== options.expectedFallback.raw) throw new LocalBookConflictError("A newer fallback edit arrived during promotion. It was kept.");
    let promotionFailure: unknown;
    try { await promoteCapturedBookFallbacks(owner, capturedBookFallbacks(owner)); }
    catch (cause) {
      if (options.requireIdb || cause instanceof LocalBookConflictError) throw cause;
      promotionFailure = cause;
    }
    const capturedFallback = selectFallback(contentKey);
    let committedMeta: BookMeta | null | undefined;
    let committedState: SyncState | undefined;
    let callbackFailure: unknown;
    let observed: { metadata: BookMeta | null; content: unknown; state: SyncState } | undefined;
    const makeEdit = (tx: IDBTransaction | null, metadata: BookMeta | null, content: unknown, state: SyncState, seq: number) => {
      let metadataChanged = false, contentChanged = false, stateChanged = false;
      const ctx: LocalBookEdit = {
        metadata, content: content ?? null, state, tx, seq,
        setMetadata(next) { ctx.metadata = next ? { ...next, ...owner } : null; metadataChanged = true; },
        setContent(next) { ctx.content = next; contentChanged = true; },
        setState(next) { ctx.state = { ...next, ...owner }; stateChanged = true; },
        markLifecycle(action, lifecycleSeq, baseBookRev, goneSeq) {
          ctx.state = { ...ctx.state, lifecycle: { action, seq: lifecycleSeq, token: newBookToken(),
            baseBookRev: baseBookRev === undefined ? (ctx.state.bootstrap ? null : ctx.state.appliedBookRev) : baseBookRev,
            goneSeq: goneSeq ?? null } }; stateChanged = true;
        },
      };
      const result = edit(ctx);
      if ((metadataChanged || contentChanged || stateChanged) && authored && tx) ctx.state = { ...ctx.state, changeSeq: seq };
      return { result, ctx, metadataChanged, contentChanged, changed: metadataChanged || contentChanged || stateChanged };
    };
    try {
      if (promotionFailure) throw promotionFailure;
      const result = await withTransaction<T>([...new Set([STORE_BOOK_META, STORE_SYNC_STATE, contentStore, ...(options.extraStores ?? [])])], "readwrite", (tx, setResult) => {
        const metadataRequest = tx.objectStore(STORE_BOOK_META).get(bookMetaKey(owner.kind, owner.id));
        const contentRequest = tx.objectStore(contentStore).get(contentKey);
        const stateRequest = tx.objectStore(STORE_SYNC_STATE).get(syncStateKey(owner.kind, owner.id));
        let pending = 3;
        const loaded = () => {
          if (--pending !== 0) return;
          const durableMetadata = (metadataRequest.result as BookMeta | undefined) ?? null;
          const durableContent = contentRequest.result;
          const durableState = (stateRequest.result as SyncState | undefined) ?? seedSyncState(owner.kind, owner.id);
          observed = { metadata: durableMetadata, content: durableContent, state: durableState };
          const runEdit = (seq: number) => {
            try {
              if (capturedFallback && (durableContent !== undefined || durableMetadata !== null)
                  && capturedFallback.envelope?.baseChangeSeq !== durableState.changeSeq
                  && (capturedFallback.envelope?.payloadPresent !== false && JSON.stringify(capturedFallback.payload) !== JSON.stringify(durableContent)
                    || capturedFallback.envelope && contentKey === owner.id
                      && JSON.stringify(capturedFallback.envelope.metadata) !== JSON.stringify(durableMetadata))) throw new LocalBookConflictError();
              const envelope = capturedFallback?.envelope;
              const changed = makeEdit(tx, envelope && contentKey === owner.id ? envelope.metadata : durableMetadata,
                capturedFallback && envelope?.payloadPresent !== false ? capturedFallback.payload : durableContent,
                envelope ? { ...durableState, lifecycle: envelope.state.lifecycle } : durableState, seq);
              if (changed.contentChanged || capturedFallback && envelope?.payloadPresent !== false) {
                if (changed.ctx.content === null) tx.objectStore(contentStore).delete(contentKey);
                else tx.objectStore(contentStore).put(changed.ctx.content, contentKey);
              }
              if (changed.metadataChanged || envelope && contentKey === owner.id) {
                if (changed.ctx.metadata) tx.objectStore(STORE_BOOK_META).put(changed.ctx.metadata, bookMetaKey(owner.kind, owner.id));
                else tx.objectStore(STORE_BOOK_META).delete(bookMetaKey(owner.kind, owner.id));
                committedMeta = changed.ctx.metadata;
              }
              if (changed.changed || capturedFallback) {
                committedState = capturedFallback && !changed.changed ? { ...changed.ctx.state, changeSeq: seq } : changed.ctx.state;
                tx.objectStore(STORE_SYNC_STATE).put(committedState, syncStateKey(owner.kind, owner.id));
              }
              setResult(changed.result);
            } catch (cause) { callbackFailure = cause; abortTransaction(tx, cause); }
          };
          if (authored || capturedFallback) allocateChangeSeqRange(tx, 1, runEdit); else runEdit(durableState.changeSeq);
        };
        metadataRequest.onsuccess = loaded; contentRequest.onsuccess = loaded; stateRequest.onsuccess = loaded;
      });
      if (capturedFallback && storage()?.getItem(capturedFallback.storageKey) === capturedFallback.raw) storage()?.removeItem(capturedFallback.storageKey);
      if (committedMeta !== undefined) cacheMeta(committedMeta, owner);
      if (committedState) cachedStates.set(syncStateKey(owner.kind, owner.id), committedState);
      updateDerivedIndexes(); emitMetadata(owner);
      return result;
    } catch (cause) {
      if (callbackFailure || options.requireIdb || cause instanceof LocalBookConflictError) throw callbackFailure ?? cause;
      const fallback = selectFallback(contentKey);
      const metadata = fallback?.envelope && contentKey === owner.id ? fallback.envelope.metadata : observed?.metadata ?? getCachedBookMeta<BookMeta>(owner.kind, owner.id);
      const state = fallback?.envelope?.state ?? observed?.state ?? cachedStates.get(syncStateKey(owner.kind, owner.id)) ?? seedSyncState(owner.kind, owner.id);
      const content = fallback && fallback.envelope?.payloadPresent !== false ? fallback.payload : observed?.content ?? null;
      const changed = makeEdit(null, metadata, content, state, state.changeSeq);
      if (!changed.changed) return changed.result;
      const envelope: FallbackBookEnvelope = { v: 2, owner, key: contentKey,
        token: authored ? newBookToken() : fallback?.envelope?.token ?? newBookToken(),
        writerId: bookWriterIdentity(), payload: changed.ctx.content,
        payloadPresent: changed.contentChanged || fallback?.envelope?.payloadPresent !== false && Boolean(fallback) || observed?.content !== undefined,
        metadata: contentKey === owner.id ? changed.ctx.metadata : null,
        state: changed.ctx.state,
        baseChangeSeq: fallback?.envelope?.baseChangeSeq ?? observed?.state.changeSeq
          ?? cachedStates.get(syncStateKey(owner.kind, owner.id))?.changeSeq ?? null };
      const key = `${SPILL_PREFIX}${contentKey}${hasBookLocks() ? "" : `${BRANCH_SEPARATOR}${envelope.writerId}`}`;
      setStorageItem(key, JSON.stringify(envelope));
      if (contentKey === owner.id) cacheMeta(changed.ctx.metadata, owner);
      emitMetadata(owner); return changed.result;
    }
  });
}

/** Promote a parent's and its children's captured envelopes as one authored edit. */
function capturedBookFallbacks(owner: BookIdentity): FallbackEntry[] {
  return allFallbackEntries().filter(entry => {
    const identity = entry.envelope?.owner ?? fallbackBookIdentity(entry.key);
    return identity?.kind === owner.kind && identity.id === owner.id;
  });
}

async function promoteCapturedBookFallbacks(owner: BookIdentity, entries: FallbackEntry[]): Promise<boolean> {
  if (entries.length === 0) return false;
  await openDb();
  const keys = [...new Set(entries.map(entry => entry.key))];
  const captured = keys.map(key => {
    const branches = entries.filter(entry => entry.key === key);
    return branches.find(entry => entry.envelope?.writerId === bookWriterIdentity()) ?? branches[0]!;
  });
  if (captured.some(first => entries.some(entry => entry.key === first.key && fallbackSignature(entry) !== fallbackSignature(first)))) {
    await withTransaction<void>([STORE_SYNC_RECOVERY], "readwrite", (tx, done) => {
      for (const entry of entries) {
        const id = `fallback-branch:${entry.envelope?.token ?? entry.storageKey}`;
        const store = tx.objectStore(STORE_SYNC_RECOVERY), existing = store.get(id);
        existing.onsuccess = () => {
          if (existing.result === undefined) store.add({ id, type: "conflict", kind: owner.kind, bookId: owner.id,
            provenance: { source: "fallback-branch", storageKey: entry.storageKey },
            content: { raw: entry.raw, key: entry.key, payload: entry.payload, envelope: entry.envelope } }, id);
        };
      }
      done(undefined);
    });
    throw new LocalBookConflictError();
  }
  // Do not substitute an envelope saved after this promotion was captured.
  for (const entry of entries) {
    if (storage()?.getItem(entry.storageKey) !== entry.raw) throw new LocalBookConflictError("A newer fallback edit arrived during promotion. It was kept.");
  }
  const contentStore = owner.kind === "problem" ? STORE_PROBLEM_BOARDS : STORE_CONTENT;
  let committedMeta: BookMeta | null = null;
  let committedState: SyncState | undefined;
  await withTransaction<void>([contentStore, STORE_BOOK_META, STORE_SYNC_STATE], "readwrite", (tx, setResult) => {
    const metadata = tx.objectStore(STORE_BOOK_META).get(bookMetaKey(owner.kind, owner.id));
    const tracking = tx.objectStore(STORE_SYNC_STATE).get(syncStateKey(owner.kind, owner.id));
    const records = captured.map(entry => tx.objectStore(contentStore).get(entry.key));
    let remaining = records.length + 2;
    const loaded = () => {
      if (--remaining !== 0) return;
      try {
        const durableMeta = (metadata.result as BookMeta | undefined) ?? null;
        const durableState = (tracking.result as SyncState | undefined) ?? seedSyncState(owner.kind, owner.id);
        // All comparisons use the original book version, before any child is written.
        for (let index = 0; index < captured.length; index++) {
          const entry = captured[index]!;
          const durableContent = records[index]!.result;
          const differingPayload = entry.envelope?.payloadPresent !== false && JSON.stringify(entry.payload) !== JSON.stringify(durableContent);
          const differingMetadata = entry.key === owner.id && entry.envelope !== null
            && JSON.stringify(entry.envelope.metadata) !== JSON.stringify(durableMeta);
          const differingLifecycle = entry.key === owner.id && entry.envelope !== null
            && JSON.stringify(entry.envelope.state.lifecycle) !== JSON.stringify(durableState.lifecycle);
          if ((durableContent !== undefined || durableMeta !== null)
              && entries.filter(branch => branch.key === entry.key).some(branch => branch.envelope?.baseChangeSeq !== durableState.changeSeq)
              && (differingPayload || differingMetadata || differingLifecycle)) throw new LocalBookConflictError();
        }
        allocateChangeSeqRange(tx, 1, seq => {
          try {
            committedMeta = durableMeta;
            let lifecycle = durableState.lifecycle;
            for (const entry of captured) {
              if (entry.envelope?.payloadPresent !== false) {
                if (entry.payload === null) tx.objectStore(contentStore).delete(entry.key);
                else tx.objectStore(contentStore).put(entry.payload, entry.key);
              }
              if (entry.key === owner.id && entry.envelope) {
                committedMeta = entry.envelope.metadata;
                lifecycle = entry.envelope.state.lifecycle;
                if (committedMeta) tx.objectStore(STORE_BOOK_META).put(committedMeta, bookMetaKey(owner.kind, owner.id));
                else tx.objectStore(STORE_BOOK_META).delete(bookMetaKey(owner.kind, owner.id));
              }
            }
            committedState = { ...durableState, changeSeq: seq, lifecycle: lifecycle ? { ...lifecycle, seq } : null };
            tx.objectStore(STORE_SYNC_STATE).put(committedState, syncStateKey(owner.kind, owner.id));
            setResult(undefined);
          } catch (cause) { abortTransaction(tx, cause); }
        });
      } catch (cause) { abortTransaction(tx, cause); }
    };
    metadata.onsuccess = loaded; tracking.onsuccess = loaded;
    for (const request of records) request.onsuccess = loaded;
  });
  // A newer token remains authoritative even if it arrived while the transaction ran.
  for (const entry of entries) if (storage()?.getItem(entry.storageKey) === entry.raw) storage()?.removeItem(entry.storageKey);
  cacheMeta(committedMeta, owner);
  if (committedState) cachedStates.set(syncStateKey(owner.kind, owner.id), committedState);
  updateDerivedIndexes(); emitMetadata(owner);

  return true;
}

export async function promoteBookFallbacks(owner: BookIdentity): Promise<boolean> {
  const entries = capturedBookFallbacks(owner);
  return withBookWrite(owner.kind, owner.id, () => promoteCapturedBookFallbacks(owner, entries));
}

export async function promoteFallbackContent(key: string): Promise<boolean> {
  if (!selectFallback(key, true)) return false;
  const owner = fallbackBookIdentity(key);
  return owner ? promoteBookFallbacks(owner) : false;
}

export async function ensureBookReadyForAtomicSync(owner: BookIdentity): Promise<void> {
  if (!hasBookLocks()) throw new Error("This device cannot coordinate atomic sync. Local work was kept.");
  await openDb();
  await promoteBookFallbacks(owner);
  if (listBookFallbacks().some(entry => entry.owner.kind === owner.kind && entry.owner.id === owner.id)) throw new LocalBookConflictError("A newer fallback edit was kept. Retry after resolving its local copy.");
}

export function resetLocalBookStoreForTests(): void {
  cache.clear(); cachedStates.clear(); metadataReady = false; cacheStorage = storage();
  broadcast?.close(); broadcast = null; installingBroadcast = false;
}
