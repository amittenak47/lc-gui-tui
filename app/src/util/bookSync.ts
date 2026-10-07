/** Current-state sync. Staging is invisible; one commit publishes one book. */
import { LcApiError, type LcClient, type BookStateDto, type BookPageStateDto, type CommitRequestDto, type CommitResultDto } from "../api/client";
import { b64ToBytes, bytesToB64 } from "../api/nativeHttp";
import { captureBook, acknowledgeBook, publishBook, localizedRecordHash, retainInlineChoices, pageIdentity, wirePageKey, localPageKey,
  type BookCapture, type PreparedBookPage } from "./bookSnapshot";
import { convertInlineBook } from "./bookInlineInk";
import { newBookToken, withBookSync } from "./bookCoordinator";
import { ensureBookReadyForAtomicSync, mutateLocalBook, LocalBookConflictError } from "./localBookStore";
import { type BookIdentity, type SyncState } from "./syncState";
import { encodedFromRecord, type InkPageRecord } from "./inkPageStore";
import { packEncodedInk, encodeInkOps } from "../canvas/inkCodec";
import { recordHash, hashBytes, canonicalJson, validateInk } from "./syncContent";
import { gzipBytes } from "./gzip";
import { localizeHubInkDto, pdfInkContextFromRecord, tagOutgoingPdfInk } from "./pdfInkLayout";
import { artifactCatalogFields } from "./padArtifacts";
import { uploadArtifactAssets, downloadArtifactAssets } from "./artifactAssetSync";
import { getDocBytes, putDocBytes, bytesMatchDocHash } from "./docBytes";
import { waitForConflictUi, type ConflictUiLifecycle } from "./conflictUiWait";
import { HubSyncCancelled } from "./hubConflictStash";
import { mergeEncodedPages } from "./inkSync";
import { prepareArtifactConflict } from "./artifactConflict";
import { editArtifactCatalog } from "./artifactCatalogEdits";
import { stageWhiteboardArtifactSnapshot } from "./artifactWhiteboards";
import { problemCanvasSnapshot } from "./problemArtifactConflict";
import type { BoardBlob } from "../canvas/BoardHandle";
import { bookDisplay, type BookDisplay } from "./bookSyncMessages";

export type BookErrorKind = "unreachable" | "storage" | "needs_choice" | "merge_mount" | "local_page" | "hub_page"
  | "stage" | "unconfirmed" | "hub_changed" | "local_changed" | "missing_staging" | "dependency" | "gone" | "cap" | "invalid";
export class BookSyncError extends Error {
  missing = false;
  constructor(readonly kind: BookErrorKind, message: string, readonly pages: Array<{ key: string; pageId: number }> = [], readonly cause?: unknown) {
    super(message); this.name = "BookSyncError";
  }
}
/** Preserve the hub's structured corrupt-page identity without parsing prose. */
export function unreadableHubError(body: unknown, cause?: unknown): BookSyncError | null {
  if (!body || typeof body !== "object") return null;
  const error = body as { status?: unknown; message?: unknown; pages?: unknown };
  if (error.status !== "unreadable_content") return null;
  const pages = (Array.isArray(error.pages) ? error.pages : []).flatMap(page =>
    page && typeof page.key === "string" && Number.isSafeInteger(page.page_id) && page.page_id >= 0
      ? [{ key: page.key, pageId: page.page_id as number }] : []);
  return new BookSyncError(pages.length ? "hub_page" : "invalid",
    typeof error.message === "string" ? error.message : "Unreadable hub content", pages, cause);
}
export interface BookResult extends BookIdentity {
  status: "synced" | "unchanged" | "failed" | "needs_choice" | "cancelled";
  committed: boolean;
  error?: BookSyncError;
  display?: BookDisplay;
}
export type BookChoice = "local" | "server" | "merged" | "none";
export interface BookResolution {
  record?: BookChoice;
  recordValue?: Record<string, unknown>;
  pages?: Array<{ key: string; pageId: number; choice: BookChoice }>;
  lifecycle?: "local" | "server";
  boardRemints?: Record<string, string>;
}
export interface BookConflict {
  capture: BookCapture;
  remote: BookStateDto;
  record: boolean;
  lifecycle: boolean;
  pages: BookPageStateDto[];
  loadPage(page: BookPageStateDto): Promise<PreparedBookPage>;
}
export interface BookSyncOptions {
  manual?: boolean;
  allowCreate?: boolean;
  signal?: AbortSignal;
  requestChoice?(conflict: BookConflict, lifecycle: ConflictUiLifecycle): Promise<BookResolution>;
  /** Isolated fault harnesses replace waiting, never production retry limits. */
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>;
  timeoutMs?: number;
  beforePublish?(capture: BookCapture, remote: BookStateDto): Promise<void>;
}
const running = new Map<string, Promise<BookResult>>();
const retries = [1_000, 3_000];
type Classification = "equal" | "skip" | "upload" | "download" | "conflict";
export function classifyBookItem(local: string | null, baseLocal: string | null, remote: string | null, remoteRev: number, baseRev: number): Classification {
  if (local === null && remote === null) return "skip";
  if (local !== null && local === remote) return "equal";
  if (local === null) return "download";
  if (remote === null) return baseRev > 0 ? "conflict" : "upload";
  if (baseLocal === null) return "conflict";
  const authored = local !== baseLocal, moved = remoteRev !== baseRev;
  if (authored && moved) return "conflict";
  if (authored) return "upload";
  return moved ? "download" : "skip";
}
function stop(signal: AbortSignal) { if (signal.aborted) throw new HubSyncCancelled(); }
/** Human/lock waits have no time limit, but a joining caller can still cancel. */
export function awaitBookOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  stop(signal);
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { signal.removeEventListener("abort", cancel); reject(new HubSyncCancelled()); };
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(value => { signal.removeEventListener("abort", cancel); resolve(value); }, cause => { signal.removeEventListener("abort", cancel); reject(cause); });
  });
}
export function boundedBookRequest<T>(work: () => Promise<T>, signal: AbortSignal, timeoutMs = 30_000): Promise<T> {
  stop(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve(value!);
    };
    const cancel = () => finish(new HubSyncCancelled());
    const timer = setTimeout(() => finish(new LcApiError("No response from the hub", 0)), timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    try { Promise.resolve(work()).then(value => finish(null, value), error => finish(error)); } catch (error) { finish(error); }
  });
}
const wait = (milliseconds: number, signal: AbortSignal) => boundedBookRequest(() => new Promise<void>(resolve => setTimeout(resolve, milliseconds)), signal, milliseconds + 100);
function retryable(cause: unknown) { return !(cause instanceof LcApiError) || cause.status === 0 || cause.status === 408 || cause.status >= 500; }
async function retryThree<T>(work: () => Promise<T>, signal: AbortSignal, options: BookSyncOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    stop(signal);
    try { return await work(); } catch (cause) {
      if (cause instanceof HubSyncCancelled || attempt === 2 || !retryable(cause)) throw cause;
      await (options.wait ?? wait)(retries[attempt]!, signal);
    }
  }
}
const vector = (book: BookStateDto) => book.state === "gone" ? book.retained_restore_pages ?? [] : book.pages;
interface LocalPage { row: InkPageRecord; key: string; hash: string; localHash: string; gz: string }
async function prepareLocalPages(capture: BookCapture): Promise<Map<string, LocalPage>> {
  const pages = new Map<string, LocalPage>();
  const ctx = capture.kind === "annotate" ? pdfInkContextFromRecord(capture.record) : null;
  for (const row of capture.pages) {
    const key = wirePageKey(capture, row.docKey);
    try {
      const encoded = await encodedFromRecord(row);
      if (!encoded) throw new Error("Unreadable packed handwriting");
      const packed = packEncodedInk(encoded), checked = await validateInk(packed);
      const tagged = await tagOutgoingPdfInk(await gzipBytes(packed), key === capture.id && !row.layoutPending ? ctx : null);
      const outgoing = await validateInk(tagged);
      pages.set(pageIdentity(key, row.pageId), { row, key, localHash: checked.wireHash, hash: outgoing.wireHash, gz: bytesToB64(tagged) });
    } catch (cause) { throw new BookSyncError("local_page", "Local handwriting cannot be read", [{ key, pageId: row.pageId }], cause); }
  }
  return pages;
}
async function acquirePage(client: LcClient, capture: BookCapture, remote: BookStateDto, page: BookPageStateDto, options: BookSyncOptions, signal: AbortSignal): Promise<PreparedBookPage> {
  const docKey = localPageKey(capture, page.key);
  const dto = await boundedBookRequest(() => client.getInkPage(capture.kind as "annotate" | "whiteboard", page.key, page.page_id,
    { bookRev: remote.book_rev, pageRev: page.rev }, { timeoutMs: options.timeoutMs }), signal, options.timeoutMs);
  if (!dto) {
    const error = new BookSyncError("hub_page", "The advertised hub page is missing", [{ key: page.key, pageId: page.page_id }]);
    error.missing = true; throw error;
  }
  try {
    const validated = await validateInk(b64ToBytes(dto.gz));
    if (validated.wireHash !== page.hash || dto.rev !== page.rev) throw new Error("Pinned handwriting identity does not match");
    const ctx = capture.kind === "annotate" ? pdfInkContextFromRecord(capture.record) : null;
    const remoteBoard = remote.record?.board as { appState?: { pdfWidth?: number } } | undefined;
    const localized = await boundedBookRequest(() => localizeHubInkDto(client, dto, ctx, remoteBoard?.appState?.pdfWidth ?? null), signal, options.timeoutMs);
    const checked = await validateInk(b64ToBytes(localized.gz));
    return { remote: page, localHash: checked.wireHash, row: { v: 1, docKey, pageId: page.page_id,
      gz: b64ToBytes(localized.gz), dirty: false, updatedAt: dto.updated_at,
      ...(capture.kind === "annotate" && (remote.record?.doc_type ?? capture.metadata?.docType) === "pdf" && page.key === capture.id && !localized.localized ? { layoutPending: true } : {}) } };
  } catch (cause) {
    if (cause instanceof LcApiError && cause.status === 409) throw cause;
    throw new BookSyncError("hub_page", "Hub handwriting cannot be read", [{ key: page.key, pageId: page.page_id }], cause);
  }
}
async function prepareDependencies(client: LcClient, capture: BookCapture, record: Record<string, unknown> | null, outgoing: boolean, options: BookSyncOptions, signal: AbortSignal): Promise<void> {
  if (!record) return;
  try {
    const catalog = artifactCatalogFields(record.artifacts, capture).artifacts;
    await boundedBookRequest(() => outgoing ? uploadArtifactAssets(client, catalog) : downloadArtifactAssets(client, catalog), signal, options.timeoutMs);
    if (capture.kind === "annotate" && ["pdf", "epub"].includes(String(record.doc_type))) {
      const hash = String(record.hash);
      if (outgoing) {
        if (!await boundedBookRequest(() => client.docBytesOnHub(hash), signal, options.timeoutMs)) {
          const bytes = await getDocBytes(hash);
          if (!bytes || !bytesMatchDocHash(hash, bytes)) throw new Error("Missing source bytes");
          await boundedBookRequest(() => client.putDocBytes(hash, bytes), signal, (options.timeoutMs ?? 30_000) + 1_000 * Math.ceil(bytes.byteLength / 262_144));
        }
      } else if (!await getDocBytes(hash)) {
        const bytes = await boundedBookRequest(() => client.getDocBytes(hash), signal, options.timeoutMs);
        if (!bytes || !bytesMatchDocHash(hash, bytes)) throw new Error("Unreadable source bytes");
        await putDocBytes(hash, bytes);
      }
    }
  } catch (cause) { if (cause instanceof HubSyncCancelled) throw cause; throw new BookSyncError("dependency", "Source file or attachment is unavailable", [], cause); }
}
async function applyChoices(client: LcClient, conflict: BookConflict, resolution: BookResolution, local: Map<string, LocalPage>, options: BookSyncOptions, signal: AbortSignal): Promise<void> {
  const { capture, remote } = conflict;
  const displayed = remote.record ? await localizedRecordHash(remote.record, capture, false) : null;
  let record = conflict.lifecycle && capture.state.lifecycle?.action === "delete" ? null : capture.record;
  if (conflict.record) {
    if (resolution.record === "server") record = displayed?.record ?? null;
    else if (resolution.record === "merged") record = resolution.recordValue ?? capture.record;
    else if (resolution.record !== "local") throw new BookSyncError("invalid", "A record choice is required");
  }
  if (capture.kind === "problem" && resolution.recordValue && conflict.record) record = resolution.recordValue;
  if (record && conflict.record) {
    try {
      const parent = { kind: capture.kind, id: capture.id };
      let artifacts = await boundedBookRequest(() => prepareArtifactConflict(client, parent,
        artifactCatalogFields(capture.record?.artifacts, capture).artifacts, remote.record?.artifacts,
        resolution.record === "server" ? "server" : "local"), signal, options.timeoutMs);
      if (capture.kind === "problem" && resolution.record === "merged" && remote.record?.board) {
        const content = await boundedBookRequest(() => stageWhiteboardArtifactSnapshot(parent, newBookToken(),
          problemCanvasSnapshot(remote.record!.board as BoardBlob)), signal, options.timeoutMs);
        artifacts = editArtifactCatalog(artifacts, parent, artifacts?.revision ?? null, { type: "create", id: newBookToken(),
          title: `${capture.metadata?.taskId ?? "Problem board"} (conflict copy)`, content, associations: [{ kind: "file" }] });
      }
      if (artifacts) record = { ...record, artifacts };
    } catch (cause) { if (cause instanceof HubSyncCancelled) throw cause; throw new BookSyncError("dependency", "Conflict attachments could not be preserved", [], cause); }
  }
  const pages: PreparedBookPage[] = [];
  const alternatives: PreparedBookPage[] = [];
  for (const page of conflict.pages) {
    const identity = pageIdentity(page.key, page.page_id), mine = local.get(identity);
    const choice = resolution.pages?.find(row => row.key === page.key && row.pageId === page.page_id)?.choice;
    if (!choice) throw new BookSyncError("invalid", "A choice is required for every conflicting page");
    const server = await conflict.loadPage(page); alternatives.push(server);
    let row = server.row;
    if (choice === "local") {
      if (!mine) {
        const child = page.key.slice(`${capture.id}/fn/`.length);
        const children = capture.record?.footnote_boards as Record<string, unknown> | undefined;
        if (capture.kind !== "annotate" || page.key === capture.id || remote.state !== "live" || children?.[child]) throw new BookSyncError("invalid", "A retained hub page has no local alternative");
        const encoded = await encodedFromRecord(server.row);
        row = { ...server.row, gz: undefined, inkC: { ...encodeInkOps([]), ...(encoded?.layout ? { layout: encoded.layout } : {}) } };
      } else row = mine.row;
    } else if (choice === "none" || choice === "merged") {
      const serverInk = await encodedFromRecord(server.row), localInk = mine ? await encodedFromRecord(mine.row) : encodeInkOps([]);
      if (!serverInk || !localInk) throw new BookSyncError("hub_page", "A conflict page cannot be decoded", [{ key: page.key, pageId: page.page_id }]);
      const chosen = choice === "none" ? { ...encodeInkOps([]), ...(serverInk.layout ? { layout: serverInk.layout } : {}) } : { ...mergeEncodedPages(new Map([[page.page_id, localInk]]), new Map([[page.page_id, serverInk]])).get(page.page_id)!, ...(serverInk.layout ? { layout: serverInk.layout } : {}) };
      row = { ...server.row, inkC: chosen, gz: undefined };
    }
    // The base is the displayed server's localized representation, even when
    // merging produces the old common base or a readable empty erasure.
    pages.push({ ...server, row });
  }
  await prepareDependencies(client, capture, remote.record, false, options, signal);
  await prepareDependencies(client, capture, record, false, options, signal);
  for (const page of vector(remote)) if (!alternatives.some(row => row.remote.key === page.key && row.remote.page_id === page.page_id)) alternatives.push(await conflict.loadPage(page));
  // A kept child must remain referenced by its parent. Server removal keeps
  // the complete losing child in recovery before clearing its active reference.
  if (record && capture.kind === "annotate") {
    const selectedChildren = { ...(record.footnote_boards as Record<string, unknown> ?? {}) };
    for (const page of pages) if (page.remote.key !== capture.id) {
      const id = page.remote.key.slice(`${capture.id}/fn/`.length);
      const pick = resolution.pages?.find(item => item.key === page.remote.key && item.pageId === page.remote.page_id)?.choice;
      if (pick === "local" || pick === "merged" || pick === "server") {
        const source = pick === "server" ? remote.record : capture.record;
        const child = source?.footnote_boards as Record<string, unknown> | undefined;
        if (!selectedChildren[id] && child?.[id]) {
          selectedChildren[id] = child[id];
          const notes = structuredClone(Array.isArray(record.footnotes) ? record.footnotes : []) as Array<Record<string, unknown>>;
          for (const note of Array.isArray(source?.footnotes) ? source.footnotes as Array<Record<string, unknown>> : []) {
            const refs = (Array.isArray(note.whiteboards) ? note.whiteboards : []) as Array<{ id: string }>;
            const ref = refs.find(item => item.id === id); if (!ref) continue;
            const current = notes.find(item => item.id === note.id);
            if (current) current.whiteboards = [...(Array.isArray(current.whiteboards) ? current.whiteboards : []), ref];
            else notes.push({ ...note, whiteboards: [ref] });
          }
          record = { ...record, footnotes: notes };
        }
      }
    }
    for (const [oldId, freshId] of Object.entries(resolution.boardRemints ?? {})) {
      localPageKey(capture, `${capture.id}/fn/${freshId}`);
      for (const page of alternatives.filter(item => item.remote.key === `${capture.id}/fn/${oldId}`)) pages.push({ ...page,
        remote: { ...page.remote, key: `${capture.id}/fn/${freshId}`, rev: 0 }, row: { ...page.row, docKey: localPageKey(capture, `${capture.id}/fn/${freshId}`) } });
    }
    record = { ...record, footnote_boards: selectedChildren };
  }
  const current = await boundedBookRequest(() => client.getBookState(capture.kind, capture.id, { timeoutMs: options.timeoutMs }), signal, options.timeoutMs);
  if (current.book_rev !== remote.book_rev) throw new LcApiError("The displayed hub version changed", 409);
  let lifecycle = capture.state.lifecycle;
  if (conflict.lifecycle) {
    if (resolution.lifecycle === "local" && lifecycle) {
      lifecycle = { ...lifecycle, seq: lifecycle.action === "restore" ? Math.max(lifecycle.seq, (remote.gone_seq ?? 0) + 1) : lifecycle.seq,
        baseBookRev: remote.book_rev, goneSeq: remote.gone_seq };
      if (record) record = { ...record, sync_seq: lifecycle.seq };
    }
    else if (resolution.lifecycle === "server") lifecycle = null;
    else throw new BookSyncError("invalid", "An explicit lifecycle choice is required");
  }
  await publishBook(capture, { book: remote, record, recordLocalHash: displayed?.hash ?? null, pages,
    alternative: { book: remote, pages: alternatives }, authored: true, lifecycle });
}

/** At most one promise per context; Web Locks cover cross-context attempts. */
export async function syncBook(client: LcClient, kind: BookIdentity["kind"], id: string, inventory?: BookStateDto, options: BookSyncOptions = {}): Promise<BookResult> {
  const key = `${kind}:${id}`, existing = running.get(key);
  if (existing) {
    let result: BookResult;
    try { result = await awaitBookOperation(existing, options.signal); }
    catch (cause) { if (cause instanceof HubSyncCancelled) return { kind, id, status: "cancelled", committed: false }; throw cause; }
    if (!options.manual || options.signal?.aborted || !["needs_choice", "cancelled"].includes(result.status)) return result;
    return syncBook(client, kind, id, inventory, options);
  }
  const work = executeBook(client, { kind, id }, inventory, options);
  running.set(key, work);
  try { return await work; } finally { if (running.get(key) === work) running.delete(key); }
}
async function executeBook(client: LcClient, owner: BookIdentity, inventory: BookStateDto | undefined, options: BookSyncOptions): Promise<BookResult> {
  const signal = options.signal ?? new AbortController().signal;
  let committed = false, hubRestarts = 0, localRestarts = 0;
  let display = bookDisplay(owner);
  try {
    const result = await withBookSync<BookResult>(owner.kind, owner.id, async () => {
      try { await ensureBookReadyForAtomicSync(owner); } catch (cause) { throw new BookSyncError("storage", "Local storage is not ready for safe sync", [], cause); }
      let previous = await captureBook(owner);
      if (previous.state.lastAttempt) {
        const receipt = await boundedBookRequest(() => client.getPadCommit(previous.state.lastAttempt!.uploadId, { timeoutMs: options.timeoutMs }), signal, options.timeoutMs);
        if (receipt) {
          if (receipt.book.kind !== owner.kind || receipt.book.id !== owner.id) throw new BookSyncError("invalid", "Wrong receipt book identity");
          committed = true; await acknowledgeBook(previous, previous.state.lastAttempt, receipt);
        }
        inventory = undefined;
      }
      for (;;) {
        stop(signal);
        const capture = await captureBook(owner);
        display = bookDisplay(owner, capture.metadata, capture.record);
        const localInline = capture.record ? await convertInlineBook(capture, capture.record, capture.state.changeSeq) : null;
        const effectiveCapture = localInline ? { ...capture, record: localInline.record, pages: [...capture.pages] } : capture;
        if (localInline) for (const row of localInline.rows) {
          const existing = effectiveCapture.pages.find(page => page.docKey === row.docKey && page.pageId === row.pageId);
          if (existing) {
            const first = await encodedFromRecord(existing), second = await encodedFromRecord(row);
            if (!first || !second) throw new BookSyncError("local_page", "Legacy handwriting cannot be read", [{key:wirePageKey(capture,row.docKey),pageId:row.pageId}]);
            if ((await validateInk(packEncodedInk(first))).wireHash !== (await validateInk(packEncodedInk(second))).wireHash) {
              await retainInlineChoices(capture, localInline.record, localInline.rows);
              throw new BookSyncError("needs_choice", "Inline handwriting and saved pages differ. Choose either complete version in Retained copies, then sync again.");
            }
          } else effectiveCapture.pages.push(row);
        }
        const local = await prepareLocalPages(effectiveCapture);
        if (!localInline?.converted && capture.record && capture.kind !== "problem") {
          const validateManifest = (board: unknown, key: string) => {
            const manifest = (board as { inkPages?: { pageIds?: unknown } } | undefined)?.inkPages;
            if (!manifest) return;
            if (!Array.isArray(manifest.pageIds)) throw new BookSyncError("local_page", "The saved handwriting manifest is unreadable");
            for (const pageId of manifest.pageIds) if (!Number.isSafeInteger(pageId) || pageId < 0 || !local.has(pageIdentity(key, pageId))) {
              throw new BookSyncError("local_page", "A saved handwriting page is missing", [{ key, pageId }]);
            }
          };
          validateManifest(capture.record.board, capture.id);
          for (const [id, child] of Object.entries(capture.record.footnote_boards as Record<string, { board?: unknown }> ?? {})) validateManifest(child.board, `${capture.id}/fn/${id}`);
        }
        const remote = inventory ?? await boundedBookRequest(() => client.getBookState(owner.kind, owner.id, { timeoutMs: options.timeoutMs }), signal, options.timeoutMs);
        inventory = undefined;
        const hubDisplay = bookDisplay(owner, capture.metadata, remote.record);
        display = { title: display.title === "Book" ? hubDisplay.title : display.title, scratchTitles: { ...hubDisplay.scratchTitles, ...display.scratchTitles } };
        if (remote.kind !== owner.kind || remote.id !== owner.id) throw new BookSyncError("invalid", "Wrong book identity returned by hub");
        if (remote.record && await recordHash(remote.record) !== remote.record_hash) throw new BookSyncError("invalid", "The hub record doesn't match its advertised content hash");
        const seenPages = new Set<string>();
        for (const page of vector(remote)) {
          try { localPageKey(capture, page.key); } catch (cause) { throw new BookSyncError("invalid", "The hub returned another book's handwriting", [], cause); }
          const key = pageIdentity(page.key, page.page_id);
          if (!Number.isSafeInteger(page.page_id) || page.page_id < 0 || !Number.isSafeInteger(page.rev) || page.rev <= 0 || seenPages.has(key)) throw new BookSyncError("invalid", "The hub page vector is invalid");
          seenPages.add(key);
        }
        const restoring = capture.state.lifecycle?.action === "restore", deleting = capture.state.lifecycle?.action === "delete";
        if (remote.state === "gone" && capture.metadata?.deletedAt !== undefined && !capture.state.lifecycle) {
          await publishBook(capture, { book: remote, record: null, recordLocalHash: null, pages: [] });
          return { ...owner, status: committed ? "synced" : "unchanged", committed };
        }
        if (remote.state === "gone" && !restoring && capture.metadata?.deletedAt === undefined && capture.state.lifecycle?.action !== "delete") throw new BookSyncError("gone", "Book deleted elsewhere; local content was kept");
        if (!capture.record && remote.record && !options.allowCreate && !capture.metadata && !capture.state.lifecycle) throw new BookSyncError("needs_choice", "This book is retained outside the active library");
        const remoteInline = remote.record ? await convertInlineBook(capture, remote.record, capture.state.changeSeq) : null;
        const remoteLogicalHash = remoteInline?.converted ? await recordHash(remoteInline.record) : remote.record_hash;
        const recordLocalHash = effectiveCapture.record ? await recordHash(effectiveCapture.record) : null;
        let recordClass: Classification = deleting ? "skip" : restoring && remote.state === "gone" && capture.record ? "upload" : classifyBookItem(recordLocalHash, capture.state.baseRecordLocalHash, remoteLogicalHash, remote.record_rev, capture.state.recordRev);
        const acquired = new Map<string, PreparedBookPage>();
        const conflicts: BookPageStateDto[] = [], uploads: LocalPage[] = [], downloads: PreparedBookPage[] = [];
        const virtual = new Map<string, PreparedBookPage>();
        if (remoteInline) for (const row of remoteInline.rows) {
          const key = wirePageKey(capture, row.docKey), encoded = await encodedFromRecord(row);
          const hash = (await validateInk(packEncodedInk(encoded!))).wireHash;
          const page = { key, page_id: row.pageId, rev: 0, hash };
          virtual.set(pageIdentity(key, row.pageId), { remote: page, row, localHash: hash });
        }
        const load = async (page: BookPageStateDto) => {
          const identity = pageIdentity(page.key, page.page_id), cached = acquired.get(identity) ?? (page.rev === 0 ? virtual.get(identity) : undefined);
          if (cached) return cached;
          const value = await acquirePage(client, capture, remote, page, options, signal); acquired.set(identity, value); return value;
        };
        const remotePages = new Map(vector(remote).map(page => [pageIdentity(page.key, page.page_id), page]));
        for (const [identity, value] of virtual) if (!remotePages.has(identity)) remotePages.set(identity, value.remote);
        const dependencyConflicts = new Set<string>();
        if (owner.kind === "annotate" && remote.state === "live") {
          const localChildren = effectiveCapture.record?.footnote_boards as Record<string, unknown> ?? {};
          const hubChildren = remote.record?.footnote_boards as Record<string, unknown> ?? {};
          for (const child of new Set([...Object.keys(localChildren), ...Object.keys(hubChildren)])) {
            if (!!localChildren[child] === !!hubChildren[child]) continue;
            const key = `${owner.id}/fn/${child}`;
            const changedHere = [...local.values()].some(page => page.key === key && page.localHash !== page.row.baseLocalHash);
            const changedThere = [...remotePages.values()].some(page => page.key === key && page.rev !== (local.get(pageIdentity(key, page.page_id))?.row.syncedRev ?? 0));
            if (localChildren[child] ? changedHere && (recordClass === "download" || recordClass === "conflict")
              : changedThere && (recordClass === "upload" || recordClass === "conflict")) dependencyConflicts.add(child);
          }
          if (dependencyConflicts.size) recordClass = "conflict";
        }
        try {
          for (const [identity, page] of virtual) if (remotePages.get(identity)!.rev !== 0) {
            const shard = await load(remotePages.get(identity)!);
            if (shard.localHash !== page.localHash) {
              const saved: InkPageRecord[] = [];
              for (const item of vector(remote)) saved.push((await load(item)).row);
              await prepareDependencies(client, capture, remote.record, false, options, signal);
              await retainInlineChoices(capture, remoteInline!.record, remoteInline!.rows, saved, remote.record);
              throw new BookSyncError("needs_choice", "Inline handwriting and hub pages differ. Choose either complete version in Retained copies, then sync again.");
            }
            virtual.delete(identity);
          }
          for (const identity of deleting ? [] : new Set([...local.keys(), ...remotePages.keys()])) {
            const mine = local.get(identity), page = remotePages.get(identity);
            if (!page) {
              const child = mine && owner.kind === "annotate" && mine.key !== owner.id ? mine.key.slice(`${owner.id}/fn/`.length) : null;
              const localChildren = effectiveCapture.record?.footnote_boards as Record<string, unknown> | undefined;
              const hubChildren = remote.record?.footnote_boards as Record<string, unknown> | undefined;
              if (mine && child && !hubChildren?.[child] && remote.state === "live") {
                const encoded = encodeInkOps([]), hash = (await validateInk(packEncodedInk(encoded))).wireHash;
                const absent = { remote: { key: mine.key, page_id: mine.row.pageId, rev: 0, hash }, localHash: hash,
                  row: { ...mine.row, inkC: encoded, gz: undefined } };
                if (dependencyConflicts.has(child)) {
                  acquired.set(identity, absent); conflicts.push(absent.remote); recordClass = "conflict"; continue;
                }
                // A Server choice can retire a locally new child page the hub
                // never had. Preserve its readable erasure locally without
                // staging a foreign, unreferenced page into a live book.
                if (!localChildren?.[child] && mine.localHash === hash) { downloads.push({ ...absent, row: mine.row }); continue; }
              }
              if (mine?.row.syncedRev && !(restoring && remote.state === "gone")) throw new BookSyncError("needs_choice", "A previously synchronized page is absent from this hub version", [{ key: mine.key, pageId: mine.row.pageId }]);
              if (mine) uploads.push(mine); continue;
            }
            let classification = classifyBookItem(mine?.localHash ?? null, mine?.row.baseLocalHash ?? null,
              mine?.hash === page.hash ? mine.localHash : page.hash, page.rev, mine?.row.syncedRev ?? 0);
            // Wire/local layouts can differ. Bootstrap equality is proved by a
            // pinned localized read, never by timestamps or absent seed fields.
            if (mine && classification === "conflict" && (mine.row.bootstrap !== false || mine.row.baseLocalHash == null)) {
              const prepared = await load(page);
              if (prepared.localHash === mine.localHash) classification = "equal";
            }
            if (restoring && remote.state === "gone" && !mine) classification = "conflict";
            if (capture.kind === "annotate" && page.key !== capture.id) {
              const child = page.key.slice(`${capture.id}/fn/`.length);
              if (dependencyConflicts.has(child)) classification = "conflict";
            }
            if (classification === "conflict") conflicts.push(page);
            else if (classification === "upload") uploads.push(mine!);
            else if (classification === "download") downloads.push(await load(page));
            else if (classification === "equal") downloads.push({ remote: page, localHash: mine!.localHash, row: mine!.row });
          }
          const lifecycleConflict = !!capture.state.lifecycle && ((capture.state.lifecycle.action === "delete" && capture.state.lifecycle.baseBookRev !== remote.book_rev)
            || restoring && remote.state === "gone" && capture.state.lifecycle.baseBookRev !== remote.book_rev);
          if (recordClass === "conflict" || conflicts.length || lifecycleConflict) {
            if (!options.manual || !options.requestChoice) throw new BookSyncError("needs_choice", "Open this book and choose the version to keep", conflicts.map(page=>({key:page.key,pageId:page.page_id})),
              { record:recordClass, lifecycle:lifecycleConflict, dependencies:[...dependencyConflicts] });
            const conflict: BookConflict = { capture, remote, record: recordClass === "conflict", lifecycle: lifecycleConflict, pages: conflicts, loadPage: load };
            let resolution: BookResolution;
            try { resolution = await waitForConflictUi(lifecycle => options.requestChoice!(conflict, lifecycle), signal, "The merge window could not open"); }
            catch (cause) { if (cause instanceof HubSyncCancelled || signal.aborted) throw new HubSyncCancelled(); throw new BookSyncError("merge_mount", "The merge window could not open", [], cause); }
            await applyChoices(client, conflict, resolution, local, options, signal);
            continue;
          }
          let action: CommitRequestDto["action"] = restoring && remote.state === "gone" ? "restore" : "upsert";
          if (capture.state.lifecycle?.action === "delete") action = "delete";
          if (remote.state === "gone" && action === "upsert") {
            await publishBook(capture, { book: remote, record: null, recordLocalHash: null, pages: [] });
            return { ...owner, status: committed ? "synced" : "unchanged", committed };
          }
          const uploadRecord = recordClass === "upload" || action === "restore" || localInline?.converted === true || remoteInline?.converted === true;
          const targetRecord = recordClass === "download" ? remoteInline?.record ?? remote.record : effectiveCapture.record;
          if (remoteInline?.converted) for (const prepared of downloads) {
            const identity = pageIdentity(prepared.remote.key, prepared.remote.page_id);
            if (!virtual.has(identity) || uploads.some(row => pageIdentity(row.key, row.row.pageId) === identity)) continue;
            const encoded = await encodedFromRecord(prepared.row), bytes = await gzipBytes(packEncodedInk(encoded!));
            uploads.push({ key: prepared.remote.key, row: prepared.row, hash: (await validateInk(bytes)).wireHash, localHash: prepared.localHash, gz: bytesToB64(bytes) });
          }
          // Matching virtual rows still have to become real committed page rows.
          if (remoteInline?.converted) for (const [identity, prepared] of virtual) {
            const mine = local.get(identity);
            if (mine && !uploads.includes(mine)) uploads.push(mine);
            else if (!mine && !uploads.some(page => pageIdentity(page.key, page.row.pageId) === identity)) {
              const encoded = await encodedFromRecord(prepared.row), bytes = await gzipBytes(packEncodedInk(encoded!));
              uploads.push({ key: prepared.remote.key, row: prepared.row, hash: (await validateInk(bytes)).wireHash, localHash: prepared.localHash, gz: bytesToB64(bytes) });
            }
          }
          if (action === "restore") {
            // Restoration covers every retained and every desired page, even
            // matching erasures; actual retained revisions remain the bases.
            const children = targetRecord?.footnote_boards as Record<string, unknown> | undefined;
            for (const mine of local.values()) {
              if (mine.key !== owner.id && !children?.[mine.key.slice(`${owner.id}/fn/`.length)] && !remotePages.has(pageIdentity(mine.key, mine.row.pageId))) {
                const encoded = await encodedFromRecord(mine.row);
                if (encoded?.ops.length) throw new BookSyncError("needs_choice", "An unreferenced scratch board is retained on this device", [{ key: mine.key, pageId: mine.row.pageId }]);
                const index = uploads.indexOf(mine); if (index >= 0) uploads.splice(index, 1);
                continue;
              }
              if (!uploads.includes(mine)) uploads.push(mine);
            }
          }
          await prepareDependencies(client, capture, uploadRecord ? targetRecord : remote.record, uploadRecord, options, signal);
          let final = remote;
          let publicationCapture = capture;
          if (action === "delete" || uploadRecord || uploads.length) {
            const uploadId = newBookToken(), failed: Array<{ key: string; pageId: number }> = [];
            const stage = async (page: LocalPage) => {
              const timeoutMs = options.timeoutMs ?? 30_000 + 1_000 * Math.ceil(b64ToBytes(page.gz).byteLength / 262_144);
              const ack = await retryThree(() => boundedBookRequest(() => client.stageInkPage(uploadId, owner.kind as "annotate" | "whiteboard", page.key, page.row.pageId, page.gz, { timeoutMs }), signal, timeoutMs), signal, options);
              if (ack.hash !== page.hash) throw new BookSyncError("invalid", "The stage acknowledged different handwriting");
            };
            if (action !== "delete") for (const page of uploads) {
              try { await stage(page); } catch (cause) { if (cause instanceof HubSyncCancelled) throw cause; failed.push({ key: page.key, pageId: page.row.pageId }); }
            }
            if (failed.length) throw new BookSyncError("stage", "Handwriting pages did not upload", failed);
            const body: CommitRequestDto = { upload_id: uploadId, ...owner, action,
              record: uploadRecord && targetRecord && action !== "delete" ? { base_rev: remote.record_rev, value: targetRecord } : null,
              pages: action === "delete" ? [] : uploads.map(page => ({ key: page.key, page_id: page.row.pageId,
                base_rev: remotePages.get(pageIdentity(page.key, page.row.pageId))?.rev ?? 0, hash: page.hash })),
              ...(action !== "upsert" ? { base_book_rev: capture.state.lifecycle!.baseBookRev!, seq: capture.state.lifecycle!.seq,
                ...(action === "restore" ? { gone_seq: remote.gone_seq! } : {}) } : {}) };
            const attempt: NonNullable<SyncState["lastAttempt"]> = { uploadId, requestHash: await hashBytes(new TextEncoder().encode(canonicalJson(body))),
              record: body.record ? { capturedSeq: capture.state.changeSeq, wireHash: await recordHash(body.record.value), localHash: await recordHash(body.record.value) } : null,
              pages: action === "delete" ? [] : uploads.map(page => ({ key: page.key, pageId: page.row.pageId, capturedSeq: page.row.changeSeq ?? 1, wireHash: page.hash, localHash: page.localHash })),
              lifecycleToken: capture.state.lifecycle?.token ?? null };
            await mutateLocalBook(owner, { authored: false, requireIdb: true }, ctx => ctx.setState({ ...ctx.state, lastAttempt: attempt }));
            let result: CommitResultDto;
            try {
              result = await retryThree(() => boundedBookRequest(() => client.commitPad(body, { timeoutMs: options.timeoutMs }), signal, options.timeoutMs), signal, options);
            } catch (cause) {
              if (cause instanceof LcApiError && cause.status === 422) {
                const details = cause.json as { missing_pages?: Array<{ key: string; page_id: number }> } | undefined;
                const missing = details?.missing_pages ?? [];
                if (!missing.length) throw cause;
                for (const identity of missing) {
                  const page = uploads.find(page => page.key === identity.key && page.row.pageId === identity.page_id);
                  if (!page) throw new BookSyncError("missing_staging", "The hub requested an uncaptured staged page");
                  await stage(page);
                }
                try { result = await boundedBookRequest(() => client.commitPad(body, { timeoutMs: options.timeoutMs }), signal, options.timeoutMs); }
                catch (repair) { if (repair instanceof LcApiError && repair.status === 422) throw new BookSyncError("missing_staging", "A page could not be staged", missing.map(row => ({ key: row.key, pageId: row.page_id })), repair); throw repair; }
              } else if (cause instanceof LcApiError && [409, 410, 403].includes(cause.status)) throw cause;
              else {
                const receipt = await boundedBookRequest(() => client.getPadCommit(uploadId, { timeoutMs: options.timeoutMs }), signal, options.timeoutMs).catch(() => null);
                if (!receipt) throw new BookSyncError("unconfirmed", "The hub did not confirm this sync", [], cause);
                result = receipt;
              }
            }
            if (result.status !== "committed" || result.upload_id !== uploadId) throw new BookSyncError("invalid", "Invalid commit acknowledgement");
            committed = true;
            if (result.book.kind !== owner.kind || result.book.id !== owner.id) throw new BookSyncError("invalid", "Wrong commit book identity");
            await acknowledgeBook(capture, attempt, result); final = result.book;
            // Receipt metadata covers submitted versions. Reacquire a complete
            // fresh read set to account for disjoint writers during staging.
            if (final.state === "gone") {
              const after = await captureBook(owner);
              if (after.state.lifecycle && after.state.lifecycle.token !== attempt.lifecycleToken) continue;
              await publishBook(after, { book: final, record: null, recordLocalHash: null, pages: [] });
              return { ...owner, status: "synced", committed };
            }
            const afterAck = await captureBook(owner);
            if (afterAck.state.changeSeq !== capture.state.changeSeq) throw new LocalBookConflictError("A newer edit remains dirty after the upload");
            for (const before of capture.pages) {
              const after = afterAck.pages.find(row => row.docKey === before.docKey && row.pageId === before.pageId);
              if (!after || JSON.stringify([before.inkC, before.gz, before.layoutPending]) !== JSON.stringify([after.inkC, after.gz, after.layoutPending])) throw new LocalBookConflictError("Handwriting layout changed while syncing");
            }
            publicationCapture = afterAck;
            const capturedIdentities = new Map(capture.pages.map(row => [pageIdentity(wirePageKey(capture, row.docKey), row.pageId), row]));
            for (const page of vector(final)) {
              const identity = pageIdentity(page.key, page.page_id), mine = local.get(identity);
              if (mine?.hash === page.hash) {
                acquired.set(identity, { remote: page, row: capturedIdentities.get(identity) ?? mine.row, localHash: mine.localHash });
              } else acquired.set(identity, await acquirePage(client, capture, final, page, options, signal));
            }
          }
          const record = final.record ? await localizedRecordHash(final.record, capture) : null;
          const publication = action === "upsert" && !committed ? downloads : [...acquired.values()];
          // Confirm every required read still belongs to this head before CAS.
          await boundedBookRequest(() => client.checkBookHead(owner.kind, owner.id, final.book_rev, { timeoutMs: options.timeoutMs }), signal, options.timeoutMs);
          await options.beforePublish?.(capture, final); stop(signal);
          await publishBook(publicationCapture, { book: final, record: record?.record ?? null, recordLocalHash: record?.hash ?? null, pages: publication,
            ...(localInline?.converted || remoteInline?.converted ? { alternative: { book: remote, pages: [...acquired.values(), ...virtual.values()] } } : {}),
            lifecycle: restoring && final.state === "live" ? null : undefined });
          return { ...owner, status: committed || recordClass === "download" || downloads.some(page => !local.has(pageIdentity(page.remote.key, page.remote.page_id))
            || local.get(pageIdentity(page.remote.key, page.remote.page_id))!.localHash !== page.localHash) ? "synced" : "unchanged", committed };
        } catch (cause) {
          if (cause instanceof LcApiError && cause.status === 409) {
            if (++hubRestarts > 2) throw new BookSyncError("hub_changed", "The book keeps changing on the hub", [], cause);
            continue;
          }
          if (cause instanceof LocalBookConflictError) {
            if (++localRestarts > 2) throw new BookSyncError("local_changed", "The book keeps changing on this device", [], cause);
            continue;
          }
          throw cause;
        }
      }
    }, signal);
    return { ...result, display };
  } catch (cause) {
    if (cause instanceof HubSyncCancelled || signal.aborted) return { ...owner, status: "cancelled", committed };
    const error = cause instanceof BookSyncError ? cause : cause instanceof LcApiError
      ? unreadableHubError(cause.json, cause) ?? new BookSyncError(cause.status === 410 ? "gone" : cause.status === 403 ? "cap" : cause.status === 0 ? "unreachable" : "invalid", cause.message, [], cause)
      : new BookSyncError("storage", cause instanceof Error ? cause.message : String(cause), [], cause);
    return { ...owner, status: error.kind === "needs_choice" ? "needs_choice" : "failed", committed, error, display };
  }
}
