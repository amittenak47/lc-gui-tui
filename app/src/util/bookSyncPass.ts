/** One bounded inventory, selected book first, independent per-book failures. */
import type { LcClient, PadSyncPingDto, BookStateDto, PadSnapshotDto } from "../api/client";
import { run, STORE_BOOK_META, STORE_SYNC_STATE } from "./idb";
import { syncStateNeedsWork, type BookIdentity, type BookMeta, type SyncState } from "./syncState";
import { listBookFallbacks, listFallbackContentKeys, fallbackBookIdentity } from "./localBookStore";
import { syncBook, boundedBookRequest, awaitBookOperation, BookSyncError, unreadableHubError, type BookResult, type BookSyncOptions } from "./bookSync";
import { listAllPadSnapshots, getPadSnapshot, type PadSnapshot } from "./padSnapshotStore";
import { snapshotCopyHash } from "./syncContent";
import { loadHubAutosync, HUB_AUTOSYNC_EVENT } from "./hubAutoSyncPref";
import { parseArtifactSnapshotBundle, stageArtifactSnapshot } from "./artifactSnapshot";
import { syncEdges } from "./inkSync";
import { HubSyncCancelled } from "./hubConflictStash";
import { bookDisplay, bookPassSummary, bookFailureMessage, bookNoticeMessage } from "./bookSyncMessages";
import { debugLog } from "./debugLog";
import { bookWireRecord } from "./bookWireRecord";
import { applyFootnotePing } from "./footnoteRequests";

export const BOOK_PASS_STATUS_EVENT = "lc-book-pass-status";

export interface BookPassNotice { kind: "old_hub" | "backup" | "links"; book?: BookIdentity; title?: string; cause?: unknown }
export interface BookPassResult { modern: boolean; books: BookResult[]; notices: BookPassNotice[]; cancelled: boolean }
export interface BookPassOptions extends BookSyncOptions {
  selected?: BookIdentity;
  prepare?(): Promise<void>;
  ping?: PadSyncPingDto;
  silent?: boolean;
  libraryPull?: boolean;
  onProgress?(done: number, total: number, book: BookIdentity): void;
}
let active: { promise: Promise<BookPassResult>; silent: boolean } | null = null;
let warnedOldHub = false;
export function takeOldBookHubNotice(): BookPassNotice | null {
  if (warnedOldHub) return null;
  warnedOldHub = true; return { kind: "old_hub" };
}
export function isModernBookHub(ping: PadSyncPingDto): boolean { return ping.features?.includes("atomic_book_sync_v1") === true; }
const identity = (book: BookIdentity) => `${book.kind}:${book.id}`;
function snapshotBody(snapshot: PadSnapshot): PadSnapshotDto {
  const { kind, key, tier, writtenAt, snapshotId: _snapshotId, ...payload } = snapshot;
  // These optional local DTO fields have explicit omission semantics. Unknown
  // fields remain untouched and are validated by the shared JSON contract.
  for (const field of ["footnotes", "agent", "pageCount", "source", "ink", "footnoteBoards", "footnoteInk", "edges", "artifactBundle"]) {
    if (payload[field as keyof typeof payload] === undefined) delete payload[field as keyof typeof payload];
  }
  return { kind, key, tier, written_at: writtenAt, payload: bookWireRecord(payload) };
}
export async function syncBookBackups(client: LcClient, signal: AbortSignal, timeoutMs?: number): Promise<BookPassNotice[]> {
  const notices: BookPassNotice[] = [], inventories = new Map<string, Set<string>>();
  for (const metadata of await listAllPadSnapshots()) {
    if (signal.aborted) throw new HubSyncCancelled();
    const owner = { kind: metadata.kind, id: metadata.key };
    try {
      const snapshot = await getPadSnapshot(metadata.kind, metadata.key, metadata.tier, metadata.snapshotId);
      if (!snapshot) throw new Error("The retained snapshot cannot be read");
      const body = snapshotBody(snapshot), hash = await snapshotCopyHash(body);
      let known = inventories.get(identity(owner));
      if (!known) {
        const rows = await boundedBookRequest(() => client.listSnapshotCopies(owner.kind, owner.id, { timeoutMs }), signal, timeoutMs);
        known = new Set(rows.map(row => row.content_hash)); inventories.set(identity(owner), known);
      }
      if (known.has(hash)) continue;
      const bundle = parseArtifactSnapshotBundle(snapshot.artifactBundle, owner);
      if (bundle) await boundedBookRequest(() => stageArtifactSnapshot(bundle, owner), signal, timeoutMs);
      await boundedBookRequest(() => client.putSnapshotCopy(owner.kind, owner.id, hash, body, { timeoutMs }), signal, timeoutMs);
      known.add(hash);
    } catch (cause) {
      if (signal.aborted || cause instanceof HubSyncCancelled) throw new HubSyncCancelled();
      notices.push({ kind: "backup", book: owner, title: metadata.name, cause });
    }
  }
  return notices;
}
export async function syncBookPass(client: LcClient, options: BookPassOptions = {}): Promise<BookPassResult> {
  if (active) {
    let joined: BookPassResult;
    try { joined = await awaitBookOperation(active.promise, options.signal); }
    catch (cause) { if (cause instanceof HubSyncCancelled) return { modern: true, books: [], notices: [], cancelled: true }; throw cause; }
    if (!options.silent && options.selected && !options.signal?.aborted && (joined.cancelled || joined.books.some(book => identity(book) === identity(options.selected!) && ["needs_choice", "cancelled"].includes(book.status)))) {
      return syncBookPass(client, options);
    }
    return joined;
  }
  const promise = executePass(client, options);
  active = { promise, silent: options.silent === true };
  try { return await promise; } finally { if (active?.promise === promise) active = null; }
}
async function executePass(client: LcClient, options: BookPassOptions): Promise<BookPassResult> {
  const abort = new AbortController(), source = options.signal;
  const cancel = () => abort.abort();
  source?.addEventListener("abort", cancel, { once: true });
  if (source?.aborted) cancel();
  const preference = () => { if (options.silent && !loadHubAutosync()) cancel(); };
  if (typeof window !== "undefined") window.addEventListener(HUB_AUTOSYNC_EVENT, preference);
  const signal = abort.signal;
  const result: BookPassResult = { modern: true, books: [], notices: [], cancelled: false };
  try {
    if (options.silent && !loadHubAutosync()) return result;
    await options.prepare?.();
    const ping = options.ping ?? await boundedBookRequest(() => client.pingPadSync(0, { timeoutMs: options.timeoutMs }), signal, options.timeoutMs);
    void applyFootnotePing(client, ping).catch(() => {});
    if (!isModernBookHub(ping)) {
      result.modern = false;
      const notice = takeOldBookHubNotice(); if (notice) result.notices.push(notice);
      return result;
    }
    const [metadata, states] = await Promise.all([
      run<BookMeta[]>(STORE_BOOK_META, "readonly", store => store.getAll()),
      run<Array<SyncState | { value: number }>>(STORE_SYNC_STATE, "readonly", store => store.getAll()),
    ]);
    const inventory = new Map<string, BookStateDto>();
    for (const book of ping.books ?? []) if ("state" in book) inventory.set(identity(book), book);
    const present = new Map(metadata.map(book => [identity(book), book]));
    const broken = new Map((ping.errors ?? []).map(error => [identity(error), error]));
    const candidates = new Map<string, BookIdentity>();
    if (options.selected) candidates.set(identity(options.selected), options.selected);
    for (const state of states) if ("kind" in state && syncStateNeedsWork(state)
      && (present.get(identity(state))?.deletedAt === undefined || state.lifecycle || state.lastAttempt)) candidates.set(identity(state), { kind: state.kind, id: state.id });
    for (const fallback of listBookFallbacks()) candidates.set(identity(fallback.owner), fallback.owner);
    for (const key of listFallbackContentKeys()) {
      const owner = fallbackBookIdentity(key); if (owner) candidates.set(identity(owner), owner);
    }
    for (const state of states) if ("kind" in state && present.has(identity(state))) {
      const remote = inventory.get(identity(state));
      if (remote && remote.book_rev !== state.appliedBookRev && present.get(identity(state))?.deletedAt === undefined) candidates.set(identity(state), { kind: state.kind, id: state.id });
    }
    for (const book of metadata) if (!states.some(state => "kind" in state && identity(state) === identity(book))) candidates.set(identity(book), book);
    if (options.libraryPull) for (const book of inventory.values()) if (book.state === "live" && present.get(identity(book))?.deletedAt === undefined) candidates.set(identity(book), book);
    for (const owner of candidates.values()) {
      if (signal.aborted) throw new HubSyncCancelled();
      options.onProgress?.(result.books.length + 1, candidates.size, owner);
      const selected = options.selected && identity(options.selected) === identity(owner);
      const unreadable = broken.get(identity(owner));
      if (unreadable) {
        result.books.push({ ...owner, display: bookDisplay(owner, present.get(identity(owner)), inventory.get(identity(owner))?.record), status: "failed", committed: false,
          error: unreadableHubError(unreadable.error) ?? new BookSyncError("invalid", unreadable.error.message) });
        continue;
      }
      result.books.push(await syncBook(client, owner.kind, owner.id, inventory.get(identity(owner)), {
        ...options, signal, manual: !options.silent && !!selected,
        requestChoice: selected ? options.requestChoice : undefined, allowCreate: options.libraryPull,
      }));
    }
    for (const error of ping.errors ?? []) if (!candidates.has(identity(error)) && (present.has(identity(error)) || options.libraryPull)) result.books.push({ kind: error.kind, id: error.id,
      display: bookDisplay(error, present.get(identity(error))), status: "failed", committed: false,
      error: unreadableHubError(error.error) ?? new BookSyncError("invalid", error.error.message) });
    result.notices.push(...await syncBookBackups(client, signal, options.timeoutMs));
    try { await boundedBookRequest(() => syncEdges(client, ping.edges ?? [], ping.gone_edges ?? []), signal, options.timeoutMs); }
    catch (cause) { if (signal.aborted) throw new HubSyncCancelled(); result.notices.push({ kind: "links", cause }); }
    return result;
  } catch (cause) {
    if (signal.aborted || cause instanceof HubSyncCancelled) result.cancelled = true;
    else if (options.selected) result.books.push({ ...options.selected, status: "failed", committed: false,
      error: cause instanceof BookSyncError ? cause : new BookSyncError("unreachable", cause instanceof Error ? cause.message : String(cause), [], cause) });
    else throw cause;
    return result;
  } finally {
    for (const book of result.books) {
      debugLog({ k: book.error ? "error" : "action", n: "book sync", a: JSON.stringify({kind:book.kind,id:book.id,committed:book.committed}),
        r: book.status, ...(book.error ? { e: bookFailureMessage(book, options.libraryPull) } : {}) });
      // Separate diagnostic entries keep every identity even when the reader's
      // line summarizes a long failed-page list.
      for (const page of book.error?.pages ?? []) debugLog({k:"error",n:"book sync page",a:JSON.stringify({kind:book.kind,id:book.id,...page}),e:book.error?.kind});
      if(book.error)debugLog({k:"error",n:"book sync cause",e:book.error.message,a:JSON.stringify({kind:book.error.kind,status:(book.error.cause as {status?:number}|undefined)?.status})});
    }
    for (const notice of result.notices) debugLog({k:"error",n:"book sync notice",e:bookNoticeMessage(notice)});
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(BOOK_PASS_STATUS_EVENT,
      { detail: { passive: options.silent === true || !options.onProgress, result, summary: bookPassSummary(result, options.libraryPull) } }));
    source?.removeEventListener("abort", cancel);
    if (typeof window !== "undefined") window.removeEventListener(HUB_AUTOSYNC_EVENT, preference);
  }
}
