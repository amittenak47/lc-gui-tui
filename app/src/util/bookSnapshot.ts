/** Immutable captures and guarded publications for the modern book protocol. */
import type { BookStateDto, BookPageStateDto, CommitResultDto } from "../api/client";
import { withBookWrite, newBookToken, inkBookIdentity } from "./bookCoordinator";
import { abortTransaction, withTransaction, STORE_BOOK_META, STORE_CONTENT, STORE_PROBLEM_BOARDS,
  STORE_INK_PAGES, STORE_SYNC_STATE, STORE_SYNC_RECOVERY } from "./idb";
import { allocateChangeSeqRange, seedSyncState, syncStateKey, type BookIdentity, type BookMeta, type SyncState } from "./syncState";
import { inkPageKey, type InkPageRecord } from "./inkPageStore";
import { notifyBookMetadataChanged, LocalBookConflictError } from "./localBookStore";
import { LOCAL_VIEW_KEYS, recordHash, hashBytes } from "./syncContent";
import { recordAuthoredExtras } from "./recordAuthoredExtras";
import { mergeAgentMessages } from "../modes/coachSessions";
import { equalStored } from "./queueMigration";
import { requireArtifactCatalogTransition } from "./artifactCatalogEdits";
import { bookWireRecord } from "./bookWireRecord";

export interface BookCapture extends BookIdentity {
  metadata: BookMeta | null;
  payload: Record<string, unknown> | null;
  children: Record<string, Record<string, unknown>>;
  pages: InkPageRecord[];
  state: SyncState;
  record: Record<string, unknown> | null;
}
export interface PreparedBookPage {
  remote: BookPageStateDto;
  row: InkPageRecord;
  localHash: string;
}
export const pageIdentity = (key: string, pageId: number): string => JSON.stringify([key, pageId]);
export function wirePageKey(owner: BookIdentity, docKey: string): string {
  const primary = `${owner.kind === "annotate" ? "md" : "wb"}:${owner.id}`;
  if (owner.kind !== "problem" && docKey === primary) return owner.id;
  const prefix = `fnwb:${owner.id}:`;
  if (owner.kind === "annotate" && docKey.startsWith(prefix)) {
    const suffix = docKey.slice(prefix.length);
    if (suffix && !suffix.includes(":") && !suffix.includes("/") && !/[\u0000-\u001f]/u.test(suffix)) return `${owner.id}/fn/${suffix}`;
  }
  throw new Error("Invalid handwriting owner; its saved data was kept.");
}
export function localPageKey(owner: BookIdentity, key: string): string {
  if (key === owner.id && owner.kind !== "problem") return `${owner.kind === "annotate" ? "md" : "wb"}:${owner.id}`;
  const prefix = `${owner.id}/fn/`;
  if (owner.kind === "annotate" && key.startsWith(prefix)) {
    const suffix = key.slice(prefix.length);
    if (suffix && !suffix.includes("/") && !suffix.includes(":") && !/[\u0000-\u001f]/u.test(suffix)) return `fnwb:${owner.id}:${suffix}`;
  }
  throw new Error("The hub returned another book's handwriting.");
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function buildRecord(capture: Omit<BookCapture, "record">): Record<string, unknown> | null {
  const { metadata: meta, payload, kind, id } = capture;
  if (!meta || !payload || meta.purgedAt !== undefined) return null;
  if (!object(payload.board) || payload.board.v !== 1 || !Array.isArray(payload.board.elements)) throw new Error("The saved book is unreadable. Its content was kept.");
  const common = { ...(object(meta.authoredExtras) ? meta.authoredExtras : {}), id,
    board: payload.board, agent: Array.isArray(payload.agent) ? payload.agent : [],
    ...(payload.artifacts !== undefined ? { artifacts: payload.artifacts } : {}) };
  if (kind === "whiteboard") return { ...common, title: meta.title, page_count: meta.pageCount, updated_at: meta.updatedAt ?? 0, sync_seq: meta.syncSeq ?? 0 };
  if (kind === "problem") return { ...common, dataset: meta.dataset, task_id: meta.taskId, updated_at: meta.updatedAt ?? 0, sync_seq: meta.syncSeq ?? 0 };
  const footnotes = payload.footnotes ?? [];
  if (!Array.isArray(footnotes)) throw new Error("The saved footnotes are unreadable. The book was kept.");
  const children: Record<string, unknown> = Object.create(null);
  for (const note of footnotes) {
    if (!object(note)) throw new Error("The saved footnotes are unreadable.");
    for (const reference of Array.isArray(note.whiteboards) ? note.whiteboards : []) {
      if (!object(reference) || typeof reference.id !== "string" || !capture.children[reference.id]) throw new Error("A saved scratch board is missing. The parent was kept.");
      Object.defineProperty(children, reference.id, { value: capture.children[reference.id], enumerable: true });
    }
  }
  return { ...common, name: meta.name, hash: meta.hash, doc_type: meta.docType,
    ...(typeof meta.label === "string" && meta.label.trim() ? { label: meta.label } : {}),
    source: payload.source ?? "", footnotes, footnote_boards: children,
    updated_at: meta.updatedAt ?? 0, sync_seq: meta.syncSeq ?? 0 };
}

/** All components and versions are read in one transaction, before any encoding. */
export async function captureBook(owner: BookIdentity): Promise<BookCapture> {
  return withBookWrite(owner.kind, owner.id, () => withTransaction<BookCapture>(
    [STORE_BOOK_META, STORE_CONTENT, STORE_PROBLEM_BOARDS, STORE_INK_PAGES, STORE_SYNC_STATE], "readonly", (tx, done) => readCapture(tx, owner, done)));
}
function readCapture(tx: IDBTransaction, owner: BookIdentity, done: (capture: BookCapture) => void) {
      const meta = tx.objectStore(STORE_BOOK_META).get(syncStateKey(owner.kind, owner.id));
      const payload = tx.objectStore(owner.kind === "problem" ? STORE_PROBLEM_BOARDS : STORE_CONTENT).get(owner.id);
      const state = tx.objectStore(STORE_SYNC_STATE).get(syncStateKey(owner.kind, owner.id));
      const pages = tx.objectStore(STORE_INK_PAGES).getAll();
      const children: Record<string, Record<string, unknown>> = Object.create(null);
      let remaining = 5;
      const loaded = () => {
        if (--remaining) return;
        try {
          const capture = { ...owner, metadata: meta.result ?? null, payload: payload.result ?? null,
            state: state.result ?? seedSyncState(owner.kind, owner.id), children,
            pages: (pages.result as InkPageRecord[]).filter(row => {
              const identity = inkBookIdentity(row.docKey);
              return identity?.kind === owner.kind && identity.id === owner.id;
            }) };
          const record = buildRecord(capture);
          done({ ...capture, record: record ? bookWireRecord(record) : null });
        } catch (cause) { abortTransaction(tx, cause); }
      };
      const cursor = tx.objectStore(STORE_CONTENT).openCursor(owner.kind === "annotate"
        ? IDBKeyRange.bound(`fnwb:${owner.id}:`, `fnwb:${owner.id}:\uffff`) : IDBKeyRange.only("\u0000-no-children"));
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) { loaded(); return; }
        const childId = String(row.key).slice(`fnwb:${owner.id}:`.length);
        Object.defineProperty(children, childId, { value: row.value, enumerable: true, configurable: true }); row.continue();
      };
      for (const request of [meta, payload, state, pages]) request.onsuccess = loaded;
}

function retainedRecord(capture: BookCapture, id: string, source: string) {
  return { id, type: "record", kind: capture.kind, bookId: capture.id, provenance: { source },
    record: { meta: capture.metadata ?? { kind: capture.kind, id: capture.id }, payload: capture.payload ?? {},
      children: capture.children, ink: capture.pages, wire: capture.record } };
}

/** Ambiguous legacy representations are explicit, restorable local choices. */
export async function retainInlineChoices(capture: BookCapture, converted: Record<string, unknown>, inline: InkPageRecord[], saved = capture.pages, original = capture.record): Promise<void> {
  const parts = localRecordParts(capture, converted, capture);
  const candidate = { ...capture, metadata: parts.metadata, payload: parts.payload, record: converted,
    children: converted.footnote_boards as BookCapture["children"] ?? capture.children };
  const replaced = new Map(saved.map(page => [pageIdentity(page.docKey, page.pageId), page]));
  for (const page of inline) replaced.set(pageIdentity(page.docKey, page.pageId), page);
  const fingerprint = await hashBytes(new TextEncoder().encode(JSON.stringify({ original, saved, inline })));
  const key = `inline-choice:${capture.kind}:${capture.id}:${fingerprint}`;
  const copies = [retainedRecord({ ...candidate, pages: saved }, `${key}:pages`, "legacy-saved-page-choice"),
    retainedRecord({ ...candidate, pages: [...replaced.values()] }, `${key}:inline`, "legacy-inline-page-choice")];
  await withBookWrite(capture.kind, capture.id, () => withTransaction<void>(
    [STORE_BOOK_META, STORE_CONTENT, STORE_PROBLEM_BOARDS, STORE_INK_PAGES, STORE_SYNC_STATE, STORE_SYNC_RECOVERY], "readwrite", (tx, done) => {
      readCapture(tx, capture, actual => {
        if (!equalStored(actual, capture)) { abortTransaction(tx, new LocalBookConflictError()); return; }
        for (const copy of copies) {
          const existing = tx.objectStore(STORE_SYNC_RECOVERY).get(copy.id);
          existing.onsuccess = () => { if (!existing.result) tx.objectStore(STORE_SYNC_RECOVERY).add(copy, copy.id); };
        }
        const archive = tx.objectStore(STORE_SYNC_RECOVERY).get(key);
        archive.onsuccess = () => { if (!archive.result) tx.objectStore(STORE_SYNC_RECOVERY).add({ id: key, type: "conflict", kind: capture.kind,
          bookId: capture.id, provenance: { source: "legacy-inline-original" }, content: { capture, original, saved, inline } }, key); };
        done(undefined);
      });
    }));
}

/** Excluded view fields remain local, including on scratch boards. */
export function preserveRecordView(remote: Record<string, unknown>, local: Record<string, unknown> | null): Record<string, unknown> {
  const record = structuredClone(remote);
  const preserve = (board: unknown, prior: unknown) => {
    if (!object(board)) return;
    const state = object(board.appState) ? board.appState : (board.appState = {});
    const old = object(prior) && object(prior.appState) ? prior.appState : {};
    for (const key of LOCAL_VIEW_KEYS) {
      if (Object.hasOwn(old, key)) state[key] = old[key];
      else if (key === "scrollX" || key === "scrollY") state[key] = 0;
      else if (key === "zoom") state[key] = 1;
      else delete state[key];
    }
  };
  preserve(record.board, local?.board);
  if (object(record.footnote_boards)) for (const [id, child] of Object.entries(record.footnote_boards)) {
    if (object(child)) preserve(child.board, object(local?.footnote_boards) && object(local.footnote_boards[id]) ? local.footnote_boards[id].board : null);
  }
  return record;
}
function localRecordParts(owner: BookIdentity, record: Record<string, unknown>, capture: BookCapture) {
  const metadata: BookMeta = { ...capture.metadata, kind: owner.kind, id: owner.id, authoredExtras: recordAuthoredExtras(record),
    updatedAt: record.updated_at ?? capture.metadata?.updatedAt ?? 0, syncSeq: record.sync_seq ?? capture.metadata?.syncSeq ?? 0,
    hubAckUpdatedAt: record.updated_at ?? 0, lastSyncedAt: Date.now() };
  if (owner.kind === "annotate") Object.assign(metadata, { name: record.name, hash: record.hash, docType: record.doc_type,
    ...(record.label !== undefined ? { label: record.label } : { label: undefined }) });
  else if (owner.kind === "whiteboard") Object.assign(metadata, { title: record.title, pageCount: record.page_count });
  else Object.assign(metadata, { dataset: record.dataset, taskId: record.task_id });
  const payload = { ...(capture.payload ?? {}), board: record.board,
    agent: mergeAgentMessages(Array.isArray(capture.payload?.agent) ? capture.payload.agent : [], Array.isArray(record.agent) ? record.agent : []),
    ...(record.source !== undefined ? { source: record.source } : {}),
    ...(record.footnotes !== undefined ? { footnotes: record.footnotes } : {}),
    ...(record.artifacts !== undefined ? { artifacts: record.artifacts } : {}) };
  return { metadata, payload };
}

/** Metadata only: a confirmed response never writes captured content over new work. */
export async function acknowledgeBook(capture: BookCapture, attempt: NonNullable<SyncState["lastAttempt"]>, result: CommitResultDto): Promise<void> {
  await withBookWrite(capture.kind, capture.id, () => withTransaction<void>([STORE_SYNC_STATE, STORE_INK_PAGES, STORE_BOOK_META], "readwrite", (tx, done) => {
    const request = tx.objectStore(STORE_SYNC_STATE).get(syncStateKey(capture.kind, capture.id));
    request.onsuccess = () => {
      try {
        const current = request.result as SyncState | undefined;
        if (!current) throw new LocalBookConflictError();
        const recordMatches = attempt.record && result.book.record_hash === attempt.record.wireHash;
        const next = { ...current, observedBookRev: Math.max(current.observedBookRev, result.book.book_rev) };
        if (attempt.record && result.book.record_rev >= current.recordRev && attempt.record.capturedSeq >= current.syncedChangeSeq && recordMatches) Object.assign(next, {
          recordRev: result.book.record_rev, baseRecordWireHash: result.book.record_hash, baseRecordLocalHash: attempt.record.localHash,
          syncedChangeSeq: Math.max(current.syncedChangeSeq, attempt.record.capturedSeq), bootstrap: false,
        });
        if (current.lifecycle?.token === attempt.lifecycleToken) {
          next.lifecycle = null;
          if (result.book.state === "gone") {
            // A receipt has no captured record sequence for deletion. Do not
            // acknowledge edits made after that deletion was submitted.
            next.bootstrap = false;
            const meta = tx.objectStore(STORE_BOOK_META).get(syncStateKey(capture.kind, capture.id));
            meta.onsuccess = () => { if (meta.result) tx.objectStore(STORE_BOOK_META).put({ ...meta.result, deleteAcked: true }, syncStateKey(capture.kind, capture.id)); };
          }
        }
        if (current.lastAttempt?.uploadId === attempt.uploadId) next.lastAttempt = null;
        tx.objectStore(STORE_SYNC_STATE).put(next, syncStateKey(capture.kind, capture.id));
        for (const submitted of attempt.pages) {
          const accepted = result.page_revs.find(row => row.key === submitted.key && row.page_id === submitted.pageId && row.hash === submitted.wireHash);
          if (!accepted) continue;
          const key = inkPageKey(localPageKey(capture, accepted.key), accepted.page_id);
          const page = tx.objectStore(STORE_INK_PAGES).get(key);
          page.onsuccess = () => {
            const row = page.result as InkPageRecord | undefined;
            if (row && accepted.rev >= (row.syncedRev ?? 0) && submitted.capturedSeq >= (row.syncedChangeSeq ?? 0)) tx.objectStore(STORE_INK_PAGES).put({ ...row,
              syncedRev: accepted.rev, baseWireHash: accepted.hash, baseLocalHash: submitted.localHash,
              syncedChangeSeq: Math.max(row.syncedChangeSeq ?? 0, submitted.capturedSeq), bootstrap: false,
              dirty: (row.changeSeq ?? 1) > Math.max(row.syncedChangeSeq ?? 0, submitted.capturedSeq) }, key);
          };
        }
        done(undefined);
      } catch (cause) { abortTransaction(tx, cause); }
    };
  }));
}

export interface BookPublication {
  book: BookStateDto;
  record: Record<string, unknown> | null;
  recordLocalHash: string | null;
  pages: PreparedBookPage[];
  /** Explicit conflict decisions preserve complete alternatives in this transaction. */
  alternative?: unknown;
  authored?: boolean;
  lifecycle?: SyncState["lifecycle"];
}
/** One CAS protects the entire read set. Every hash and decoded page is prepared. */
export async function publishBook(capture: BookCapture, prepared: BookPublication): Promise<void> {
  await withBookWrite(capture.kind, capture.id, () => withTransaction<void>(
    [STORE_BOOK_META, STORE_CONTENT, STORE_PROBLEM_BOARDS, STORE_INK_PAGES, STORE_SYNC_STATE, STORE_SYNC_RECOVERY], "readwrite", (tx, done) => {
      readCapture(tx, capture, actual => {
        try {
          const current = actual.state;
          if (current.changeSeq !== capture.state.changeSeq || (current.lifecycle?.token ?? null) !== (capture.state.lifecycle?.token ?? null)
            || !equalStored(actual.metadata, capture.metadata) || !equalStored(actual.payload, capture.payload)
            || !equalStored(actual.children, capture.children) || !equalStored(actual.pages, capture.pages)) throw new LocalBookConflictError("This book changed during sync. Its newer edits were kept.");
          // Observations cannot restore a local tombstone or purge.
          if (prepared.record && (capture.metadata?.deletedAt !== undefined || capture.metadata?.purgedAt !== undefined) && capture.state.lifecycle?.action !== "restore") throw new LocalBookConflictError();
          allocateChangeSeqRange(tx, prepared.pages.length + 1, first => {
            try {
              if (prepared.alternative !== undefined) {
                const id = `book-conflict:${newBookToken()}`;
                tx.objectStore(STORE_SYNC_RECOVERY).add({ id, type: "conflict", kind: capture.kind, bookId: capture.id,
                  provenance: { source: "atomic-book-choice", bookRev: prepared.book.book_rev },
                  content: { local: capture, remote: prepared.alternative } }, id);
                if (capture.record) {
                  const copy = retainedRecord(capture, `${id}:local`, "atomic-book-local-alternative");
                  tx.objectStore(STORE_SYNC_RECOVERY).add(copy, copy.id);
                }
                const alternative = prepared.alternative as { book?: BookStateDto; pages?: PreparedBookPage[] };
                if (alternative.book?.record && alternative.pages) {
                  const remoteParts = localRecordParts(capture, preserveRecordView(alternative.book.record, capture.record), capture);
                  const remoteCapture = { ...capture, metadata: remoteParts.metadata, payload: remoteParts.payload,
                    record: alternative.book.record, children: alternative.book.record.footnote_boards as BookCapture["children"] ?? {}, pages: alternative.pages.map(page => page.row) };
                  const copy = retainedRecord(remoteCapture, `${id}:hub`, "atomic-book-hub-alternative");
                  tx.objectStore(STORE_SYNC_RECOVERY).add(copy, copy.id);
                }
                if (alternative.book?.state === "gone" && alternative.pages && capture.record) {
                  const retained = new Map(capture.pages.map(page => [pageIdentity(page.docKey, page.pageId), page]));
                  for (const page of alternative.pages) retained.set(pageIdentity(page.row.docKey, page.row.pageId), page.row);
                  const copy = retainedRecord({ ...capture, pages: [...retained.values()] }, `${id}:retained-restore`, "retained-restore-with-local-parent");
                  tx.objectStore(STORE_SYNC_RECOVERY).add(copy, copy.id);
                }
              }
              if (prepared.record) {
                const { metadata, payload } = localRecordParts(capture, prepared.record, capture);
                tx.objectStore(STORE_BOOK_META).put(metadata, syncStateKey(capture.kind, capture.id));
                tx.objectStore(capture.kind === "problem" ? STORE_PROBLEM_BOARDS : STORE_CONTENT).put(capture.kind === "problem" ? { ...metadata, ...payload } : payload, capture.id);
                if (capture.kind === "annotate" && object(prepared.record.footnote_boards)) for (const [id, value] of Object.entries(prepared.record.footnote_boards)) {
                  localPageKey(capture, `${capture.id}/fn/${id}`);
                  tx.objectStore(STORE_CONTENT).put(value, `fnwb:${capture.id}:${id}`);
                }
              }
              for (let index = 0; index < prepared.pages.length; index++) {
                const page = prepared.pages[index]!, seq = first + index + 1;
                tx.objectStore(STORE_INK_PAGES).put({ ...page.row, changeSeq: seq,
                  syncedChangeSeq: prepared.authored ? 0 : seq, syncedRev: page.remote.rev,
                  baseWireHash: page.remote.hash, baseLocalHash: page.localHash,
                  bootstrap: false, dirty: prepared.authored === true }, inkPageKey(page.row.docKey, page.row.pageId));
              }
              const next: SyncState = { ...current, changeSeq: prepared.record || prepared.authored ? first : current.changeSeq,
                syncedChangeSeq: prepared.authored || !prepared.record ? current.syncedChangeSeq : first,
                recordRev: prepared.book.record_rev, baseRecordWireHash: prepared.book.record_hash,
                baseRecordLocalHash: prepared.recordLocalHash, bootstrap: false,
                observedBookRev: Math.max(current.observedBookRev, prepared.book.book_rev),
                appliedBookRev: prepared.authored ? current.appliedBookRev : prepared.book.book_rev,
                lifecycle: prepared.lifecycle === undefined ? current.lifecycle : prepared.lifecycle };
              tx.objectStore(STORE_SYNC_STATE).put(next, syncStateKey(capture.kind, capture.id)); done(undefined);
            } catch (cause) { abortTransaction(tx, cause); }
          });
        } catch (cause) { abortTransaction(tx, cause); }
      });
    }));
  await notifyBookMetadataChanged(capture.kind, capture.id);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("lc-pad-hub", { detail: { kind: capture.kind, id: capture.id, op: "reload" } }));
}

export async function localizedRecordHash(remote: Record<string, unknown>, capture: BookCapture, validateCatalog = true): Promise<{ record: Record<string, unknown>; hash: string }> {
  const record = preserveRecordView(remote, capture.record);
  // The annotate wire DTO omits an empty child map. Local assembly always
  // carries that map; its representation baseline must match that assembly.
  if (capture.kind === "annotate" && record.footnote_boards === undefined) record.footnote_boards = {};
  record.agent = mergeAgentMessages(Array.isArray(capture.record?.agent) ? capture.record.agent : [], Array.isArray(record.agent) ? record.agent : []);
  const artifacts = validateCatalog ? requireArtifactCatalogTransition(capture.record?.artifacts, record.artifacts, capture) : record.artifacts;
  if (artifacts) record.artifacts = artifacts;
  const wire = bookWireRecord(record);
  return { record: wire, hash: await recordHash(wire) };
}
