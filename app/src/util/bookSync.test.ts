import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LcApiError, type LcClient, type BookStateDto, type CommitRequestDto, type CommitResultDto, type InkPageDto } from "../api/client";
import { syncBook, classifyBookItem, type BookConflict } from "./bookSync";
import type { ConflictUiLifecycle } from "./conflictUiWait";
import { captureBook, acknowledgeBook } from "./bookSnapshot";
import { mutateLocalBook } from "./localBookStore";
import { listRecoveryCopies } from "./syncRecovery";
import { restoreRetainedRecord } from "./recoveryRestore";
import { saveWhiteboardNotebook, renameWhiteboardNotebook } from "./whiteboardStore";
import { putInkPages, getInkPageRecord, encodedFromRecord } from "./inkPageStore";
import { closeDbForTests, withStore, STORE_INK_PAGES } from "./idb";
import { inkPageKey } from "./inkPageStore";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { getBookSyncState } from "./syncState";
import { encodeInkOps, packEncodedInk, type EncodedInk } from "../canvas/inkCodec";
import { recordHash, validateInk } from "./syncContent";
import { b64ToBytes, bytesToB64 } from "../api/nativeHttp";
import { bookFailureMessage } from "./bookSyncMessages";

const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const empty = encodeInkOps([]);
const options = { wait: async () => {}, timeoutMs: 50 };
let revision = 0;
let remote: BookStateDto;
let pages: Map<string, InkPageDto>;
let staged: Map<string, InkPageDto>;
let receipts: Map<string, CommitResultDto>;
let api: LcClient;
let locks: Map<string, Promise<unknown>>;
const pageKey = (key: string, id: number) => `${key}\u001f${id}`;
async function remoteRecord(title: string) {
  const record = { id: "book", title, page_count: 1, board, agent: [], updated_at: 5, sync_seq: 0 };
  remote = { ...remote, state: "live", record, record_hash: await recordHash(record), record_rev: ++revision, book_rev: revision };
}
async function remotePage(pageId: number, ink: EncodedInk, key = "book") {
  const gz = bytesToB64(packEncodedInk(ink)), hash = (await validateInk(b64ToBytes(gz))).wireHash;
  pages.set(pageKey(key, pageId), { kind: "whiteboard", key, page_id: pageId, gz, updated_at: 5, rev: ++revision, hash });
  remote = { ...remote, book_rev: revision, pages: [...pages.values()].map(row => ({ key: row.key, page_id: row.page_id, rev: row.rev!, hash: row.hash! })) };
}
beforeEach(async () => {
  await closeDbForTests(); resetBookCoordinatorForTests(); resetLocalBookStoreForTests();
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  locks = new Map();
  vi.stubGlobal("navigator", { locks: { request: (key: string, option: (() => Promise<unknown>) | LockOptions, callback?: () => Promise<unknown>) => {
    const work = typeof option === "function" ? option : callback!;
    const prior = locks.get(key) ?? Promise.resolve(), result = prior.catch(() => {}).then(work);
    locks.set(key, result); return result;
  } } });
  revision = 0; pages = new Map(); staged = new Map(); receipts = new Map();
  remote = { kind: "whiteboard", id: "book", book_rev: 0, state: "absent", gone_seq: null, record_rev: 0, record_hash: null, record: null, pages: [] };
  api = {
    getBookState: vi.fn(async () => structuredClone(remote)),
    checkBookHead: vi.fn(async (_kind, _id, head) => { if (head !== remote.book_rev) throw new LcApiError("head changed", 409); return { unchanged: true, book_rev: head }; }),
    getInkPage: vi.fn(async (_kind, key, pageId, conditions) => {
      const row = pages.get(pageKey(key, pageId));
      if (conditions?.bookRev !== remote.book_rev || row?.rev !== conditions.pageRev) throw new LcApiError("head/page changed", 409);
      return structuredClone(row ?? null);
    }),
    stageInkPage: vi.fn(async (uploadId, kind, key, pageId, gz) => {
      const hash = (await validateInk(b64ToBytes(gz))).wireHash;
      staged.set(`${uploadId}:${pageKey(key, pageId)}`, { kind, key, page_id: pageId, gz, updated_at: 5, hash });
      return { staged: true, hash };
    }),
    commitPad: vi.fn(async (body: CommitRequestDto) => {
      const receipt = receipts.get(body.upload_id); if (receipt) return structuredClone(receipt);
      if (body.action === "delete") {
        if (body.base_book_rev !== remote.book_rev) throw new LcApiError("head changed", 409);
        pages.clear(); remote = { ...remote, state: "gone", record: null, record_hash: null, record_rev: 0, pages: [], gone_seq: body.seq!, book_rev: ++revision };
        const result: CommitResultDto = { status: "committed", upload_id: body.upload_id, record_rev: null, page_revs: [], book: structuredClone(remote) };
        receipts.set(body.upload_id, result); return result;
      }
      if (body.record && body.record.base_rev !== remote.record_rev || body.pages.some(page => page.base_rev !== (pages.get(pageKey(page.key, page.page_id))?.rev ?? 0))) throw new LcApiError("stale item", 409);
      if (body.record) remote = { ...remote, state: "live", record: structuredClone(body.record.value), record_rev: ++revision, record_hash: await recordHash(body.record.value) };
      const pageRevisions = [];
      for (const page of body.pages) {
        const stored = staged.get(`${body.upload_id}:${pageKey(page.key, page.page_id)}`);
        if (!stored || stored.hash !== page.hash) throw new LcApiError("missing staging", 422, "", { missing_pages: [page] });
        const row = { ...stored, rev: ++revision }; pages.set(pageKey(page.key, page.page_id), row);
        pageRevisions.push({ key: page.key, page_id: page.page_id, hash: page.hash, rev: row.rev });
      }
      remote = { ...remote, book_rev: revision, pages: [...pages.values()].map(row => ({ key: row.key, page_id: row.page_id, hash: row.hash!, rev: row.rev! })) };
      const result: CommitResultDto = { status: "committed", upload_id: body.upload_id, record_rev: body.record ? remote.record_rev : null, page_revs: pageRevisions, book: structuredClone(remote) };
      receipts.set(body.upload_id, result); return result;
    }),
    getPadCommit: vi.fn(async id => structuredClone(receipts.get(id) ?? null)),
    putInkPage: vi.fn(async () => { throw new Error("Modern choices cannot write live ink"); }),
  } as unknown as LcClient;
});
afterEach(async () => { await closeDbForTests(); resetLocalBookStoreForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function save(title = "Book") { return saveWhiteboardNotebook({ id: "book", title, board, pageCount: 1, agent: [] }); }
async function initial() { await save(); await putInkPages("wb:book", [[113, empty]]); expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("synced"); }
const different = () => ({ ...empty, layout: { w: 500, spread: false } });
const drawing = (color = "#111111") => encodeInkOps([{ kind: "draw", color, baseWidth: 2, maxFullness: .8, pressureClip: .6, pressureSensitive: true,
  points: [{ x: 1, y: 2, pressure: .5 }, { x: 4, y: 5, pressure: .5 }] }]);

describe("modern current-state book sync", () => {
  it("names a corrupt hub page from a direct metadata read and keeps the complete local copy", async () => {
    await initial();const before=await captureBook({kind:"whiteboard",id:"book"});
    vi.mocked(api.getBookState).mockRejectedValue(new LcApiError("Unreadable bytes",422,undefined,
      {status:"unreadable_content",message:"Unreadable bytes",pages:[{key:"book",page_id:113}]}));
    const result=await syncBook(api,"whiteboard","book",undefined,options);
    expect(result.status).toBe("failed");expect(result.error?.pages).toEqual([{key:"book",pageId:113}]);
    expect(bookFailureMessage(result)).toBe("Book: page 113 can't be read from the hub.");
    expect(await captureBook({kind:"whiteboard",id:"book"})).toEqual(before);
  });
  it("publishes a new record and the valid empty page 113 together", async () => {
    await initial();
    expect(api.commitPad).toHaveBeenCalledOnce();
    expect(vi.mocked(api.commitPad).mock.calls[0]![0]).toMatchObject({ action: "upsert", record: { base_rev: 0, value: { title: "Book" } }, pages: [{ page_id: 113, base_rev: 0 }] });
    expect(remote.pages.map(row => row.page_id)).toEqual([113]);
    expect(await getBookSyncState("whiteboard", "book")).toMatchObject({ bootstrap: false, appliedBookRev: remote.book_rev });
    const row = (await getInkPageRecord("wb:book", 113))!; expect(row.syncedChangeSeq).toBe(row.changeSeq);
    expect((await captureBook({kind:"whiteboard",id:"book"})).metadata).not.toHaveProperty("payload");
    expect((await captureBook({kind:"whiteboard",id:"book"})).metadata).not.toHaveProperty("pages");
    expect(api.putInkPage).not.toHaveBeenCalled();
  });
  it("skips unchanged transfers and acknowledges an ink-only record candidate", async () => {
    await initial(); vi.mocked(api.stageInkPage).mockClear(); vi.mocked(api.commitPad).mockClear();
    await save();
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("unchanged");
    expect(api.commitPad).not.toHaveBeenCalled(); expect(api.stageInkPage).not.toHaveBeenCalled(); expect(api.getInkPage).not.toHaveBeenCalled();
    const state = (await getBookSyncState("whiteboard", "book"))!; expect(state.changeSeq).toBe(state.syncedChangeSeq);
  });
  it("uploads a changed page without resending unchanged shared record content", async () => {
    await initial(); vi.mocked(api.commitPad).mockClear();
    await putInkPages("wb:book", [[113, different()]]); await save();
    const result = await syncBook(api, "whiteboard", "book", undefined, options);
    expect(result.status).toBe("synced"); expect(vi.mocked(api.commitPad).mock.calls[0]![0].record).toBeNull();
  });
  it("holds every download off the stores when the second page is missing", async () => {
    await initial(); const before = await captureBook({ kind: "whiteboard", id: "book" });
    await remoteRecord("Remote rename"); await remotePage(113, different()); await remotePage(44, empty);
    const get = vi.mocked(api.getInkPage).getMockImplementation()!; vi.mocked(api.getInkPage).mockImplementation(async (...args) => args[2] === 44 ? null : get(...args));
    const result = await syncBook(api, "whiteboard", "book", undefined, options);
    expect(result.error?.kind).toBe("hub_page"); expect(await captureBook({ kind: "whiteboard", id: "book" })).toEqual(before);
  });
  it("downloads remote-only changes in one coherent local publication", async () => {
    await initial(); vi.mocked(api.commitPad).mockClear();
    await remoteRecord("Remote rename"); await remotePage(113, different());
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("synced");
    const captured = await captureBook({ kind: "whiteboard", id: "book" });
    expect(captured.record?.title).toBe("Remote rename"); expect(captured.state.appliedBookRev).toBe(remote.book_rev);
    expect(api.commitPad).not.toHaveBeenCalled();
  });
  it("keeps a divergent bootstrap page until an explicit choice", async () => {
    await save(); await putInkPages("wb:book", [[113, different()]]); await remoteRecord("Book"); await remotePage(113, empty);
    const before = await captureBook({ kind: "whiteboard", id: "book" });
    const result = await syncBook(api, "whiteboard", "book", undefined, options);
    expect(result.status).toBe("needs_choice"); expect(api.commitPad).not.toHaveBeenCalled();
    expect(await captureBook({ kind: "whiteboard", id: "book" })).toEqual(before);
  });
  it("resolves exactly the competing page locally and commits against its displayed revision", async () => {
    await initial(); await putInkPages("wb:book", [[113, different()]]); await remotePage(113, { ...drawing(), layout: { w: 700, spread: true } });
    const displayed = remote.pages[0]!.rev; const ask = vi.fn(async (conflict: BookConflict, lifecycle: ConflictUiLifecycle) => {
      lifecycle.onMounted(); expect(conflict.record).toBe(false); expect(conflict.pages.map(row => row.page_id)).toEqual([113]);
      return { pages: [{ key: "book", pageId: 113, choice: "local" as const }] };
    });
    vi.mocked(api.commitPad).mockClear();
    const result = await syncBook(api, "whiteboard", "book", undefined, { ...options, manual: true, requestChoice: ask });
    expect(result.status).toBe("synced"); expect(ask).toHaveBeenCalledOnce(); expect(api.putInkPage).not.toHaveBeenCalled();
    expect(vi.mocked(api.commitPad).mock.calls[0]![0]).toMatchObject({ record: null, pages: [{ base_rev: displayed, page_id: 113 }] });
  });
  it("recovers a landed commit after all three replies are dropped", async () => {
    await save(); await putInkPages("wb:book", [[113, empty]]);
    const commit = vi.mocked(api.commitPad).getMockImplementation()!; vi.mocked(api.commitPad).mockImplementation(async body => { await commit(body); throw new LcApiError("reply lost", 0); });
    const result = await syncBook(api, "whiteboard", "book", undefined, options);
    expect(result.status).toBe("synced"); expect(receipts.size).toBe(1); expect(api.commitPad).toHaveBeenCalledTimes(3); expect(api.getPadCommit).toHaveBeenCalledOnce();
    const calls = vi.mocked(api.commitPad).mock.calls.map(([body]) => JSON.stringify(body)); expect(new Set(calls).size).toBe(1);
  });
  it("bounds never-answering requests and retains an unconfirmed attempt for the next pass", async () => {
    await save(); vi.mocked(api.commitPad).mockImplementation(() => new Promise(() => {}));
    const result = await syncBook(api, "whiteboard", "book", undefined, { ...options, timeoutMs: 5 });
    expect(result.error?.kind).toBe("unconfirmed"); expect(api.commitPad).toHaveBeenCalledTimes(3);
    expect((await getBookSyncState("whiteboard", "book"))?.lastAttempt?.record?.capturedSeq).toBeGreaterThan(0);
    expect((await getBookSyncState("whiteboard", "book"))?.syncedChangeSeq).toBe(0);
  });
  it("retains newer edits when publication repeatedly races the local writer", async () => {
    await initial(); await remoteRecord("Server title");
    let edits = 0;
    const result = await syncBook(api, "whiteboard", "book", undefined, { ...options, beforePublish: async () => { await saveWhiteboardNotebook({ id: "book", title: "Book", pageCount: 1, board: { ...board, appState: { ...board.appState, scrollX: ++edits } } }); } });
    expect(result.error?.kind).toBe("local_changed");
    const after = await captureBook({ kind: "whiteboard", id: "book" }); expect((after.record?.board as typeof board).appState.scrollX).toBe(3);
    expect(after.state.changeSeq).toBeGreaterThan(after.state.syncedChangeSeq);
  });
  it("collects every failed stage identity and never commits a partial page set", async () => {
    await save(); await putInkPages("wb:book", [[15, empty], [44, empty], [113, empty]]);
    vi.mocked(api.stageInkPage).mockRejectedValue(new LcApiError("offline", 0));
    const result = await syncBook(api, "whiteboard", "book", undefined, options);
    expect(result.error?.pages.map(row => row.pageId).sort((a, b) => a - b)).toEqual([15, 44, 113]); expect(api.stageInkPage).toHaveBeenCalledTimes(9);
    expect(api.commitPad).not.toHaveBeenCalled(); expect(remote.state).toBe("absent");
  });
  it("uses content and revisions even when device display time moves an hour backwards", async () => {
    await initial(); vi.spyOn(Date, "now").mockReturnValue(Date.now() - 3_600_000);
    await putInkPages("wb:book", [[113, different()]]);
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("synced");
    expect(remote.pages[0]?.hash).toBe((await validateInk(packEncodedInk(different()))).wireHash);
  });
  it.each(["server", "merged", "none"] as const)("%s page choice establishes the displayed base and never reopens it", async choice => {
    await initial(); await putInkPages("wb:book", [[113, drawing("#cc0000")]]); await remotePage(113, { ...drawing(), layout: { w: 700, spread: true } });
    const displayed = remote.pages[0]!.rev;
    const ask = vi.fn(async (_conflict: BookConflict, lifecycle: ConflictUiLifecycle) => { lifecycle.onMounted(); return { pages: [{ key: "book", pageId: 113, choice }] }; });
    vi.mocked(api.commitPad).mockClear();
    const result = await syncBook(api, "whiteboard", "book", undefined, { ...options, manual: true, requestChoice: ask });
    expect(result.status).toMatch(/^(synced|unchanged)$/); expect(ask).toHaveBeenCalledOnce(); expect(api.putInkPage).not.toHaveBeenCalled();
    if (choice !== "server") expect(vi.mocked(api.commitPad).mock.calls[0]![0].pages[0]?.base_rev).toBe(displayed);
    const copies = await listRecoveryCopies("whiteboard", "book"); expect(copies.filter(copy => copy.type === "record")).toHaveLength(2);
    expect((await getInkPageRecord("wb:book", 113))?.dirty).toBe(false);
  });
  it("a kept local alternative restores its captured ink rather than the current page", async () => {
    await initial(); await putInkPages("wb:book", [[113, different()]]); await remotePage(113, { ...empty, layout: { w: 700, spread: true } });
    await syncBook(api, "whiteboard", "book", undefined, { ...options, manual: true, requestChoice: async (_conflict, lifecycle) => { lifecycle.onMounted(); return { pages: [{ key: "book", pageId: 113, choice: "server" }] }; } });
    const copy = (await listRecoveryCopies()).find(copy => copy.provenance.source === "atomic-book-local-alternative")!;
    await restoreRetainedRecord(copy.id);
    const row = (await getInkPageRecord("wb:book", 113))!;
    expect((await validateInk(packEncodedInk((await encodedFromRecord(row))!))).wireHash).toBe((await validateInk(packEncodedInk(different()))).wireHash);
    expect(row.dirty).toBe(true); expect((await listRecoveryCopies()).some(row => row.id === copy.id)).toBe(true);
  });
  it("keeps both actual renames until a choice and preserves this device's camera", async () => {
    await initial(); await saveWhiteboardNotebook({ id: "book", title: "Local rename", pageCount: 1, board: { ...board, appState: { ...board.appState, scrollX: 432 } } });
    await renameWhiteboardNotebook("book", "Local rename");
    await remoteRecord("Hub rename");
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("needs_choice");
    const ask = vi.fn(async (conflict: BookConflict, lifecycle: ConflictUiLifecycle) => { lifecycle.onMounted(); expect(conflict.record).toBe(true); expect(conflict.pages).toEqual([]); return { record: "server" as const }; });
    expect((await syncBook(api, "whiteboard", "book", undefined, { ...options, manual: true, requestChoice: ask })).status).toBe("unchanged");
    const capture = await captureBook({ kind: "whiteboard", id: "book" }); expect(capture.record?.title).toBe("Hub rename");
    expect((capture.record?.board as typeof board).appState.scrollX).toBe(432); expect(ask).toHaveBeenCalledOnce();
  });
  it("refuses to recreate a previously synchronized page omitted by the hub", async () => {
    await initial(); pages.clear(); remote = { ...remote, pages: [], book_rev: ++revision }; const before = await captureBook({ kind: "whiteboard", id: "book" });
    vi.mocked(api.commitPad).mockClear(); const result = await syncBook(api, "whiteboard", "book", undefined, options);
    expect(result.status).toBe("needs_choice"); expect(api.commitPad).not.toHaveBeenCalled(); expect(await captureBook({ kind: "whiteboard", id: "book" })).toEqual(before);
  });
  it("detects a representation-only page write between capture and publication", async () => {
    await initial(); await remotePage(113, different()); let writes = 0;
    const result = await syncBook(api, "whiteboard", "book", undefined, { ...options, beforePublish: async () => {
      const row = (await getInkPageRecord("wb:book", 113))!;
      await withStore(STORE_INK_PAGES, "readwrite", store => { store.put({ ...row, layoutPending: !!(++writes % 2) }, inkPageKey("wb:book", 113)); });
    } });
    expect(result.error?.kind).toBe("local_changed"); expect(writes).toBe(3); expect((await getInkPageRecord("wb:book", 113))?.syncedRev).not.toBe(remote.pages[0]!.rev);
  });
  it("acquires a disjoint writer's page from the full commit vector", async () => {
    await initial(); await putInkPages("wb:book", [[113, different()]]);
    const stage = vi.mocked(api.stageInkPage).getMockImplementation()!;
    vi.mocked(api.stageInkPage).mockImplementation(async (...args) => { await remotePage(44, empty); return stage(...args); });
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("synced");
    expect((await captureBook({ kind: "whiteboard", id: "book" })).pages.map(row => row.pageId).sort()).toEqual([113, 44]);
    expect((await getBookSyncState("whiteboard", "book"))?.appliedBookRev).toBe(remote.book_rev);
  });
  it("repairs a missing staged page once with the identical commit body", async () => {
    await save(); await putInkPages("wb:book", [[113, empty]]);
    const commit = vi.mocked(api.commitPad).getMockImplementation()!; let calls = 0;
    vi.mocked(api.commitPad).mockImplementation(async body => { if (++calls === 1) { staged.clear(); throw new LcApiError("missing staging", 422, "", { missing_pages: body.pages }); } return commit(body); });
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("synced");
    expect(api.stageInkPage).toHaveBeenCalledTimes(2); expect(api.commitPad).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.commitPad).mock.calls[0]![0]).toEqual(vi.mocked(api.commitPad).mock.calls[1]![0]);
  });
  it("bounds hub conflict restarts and preserves every local item", async () => {
    await save(); await putInkPages("wb:book", [[113, empty]]); const before = await captureBook({ kind: "whiteboard", id: "book" });
    vi.mocked(api.commitPad).mockRejectedValue(new LcApiError("racing", 409));
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).error?.kind).toBe("hub_changed");
    expect(api.commitPad).toHaveBeenCalledTimes(3); expect((await captureBook({ kind: "whiteboard", id: "book" })).pages).toEqual(before.pages);
  });
  it.each([[403, "cap"], [410, "gone"]] as const)("keeps local data after HTTP %s", async (status, kind) => {
    await save(); await putInkPages("wb:book", [[113, different()]]); const before = await captureBook({ kind: "whiteboard", id: "book" });
    vi.mocked(api.commitPad).mockRejectedValue(new LcApiError("refused", status));
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).error?.kind).toBe(kind);
    const after = await captureBook({ kind: "whiteboard", id: "book" }); expect(after.payload).toEqual(before.payload); expect(after.pages).toEqual(before.pages); expect(after.state.syncedChangeSeq).toBe(0);
  });
  it("does not delete a newer hub head without an explicit lifecycle choice", async () => {
    await initial(); const base = remote.book_rev;
    await mutateLocalBook({ kind: "whiteboard", id: "book" }, { requireIdb: true }, ctx => { ctx.setMetadata({ ...ctx.metadata!, deletedAt: 100 }); ctx.markLifecycle("delete", 1, base); });
    await remotePage(44, different()); vi.mocked(api.commitPad).mockClear();
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("needs_choice"); expect(api.commitPad).not.toHaveBeenCalled();
    const result = await syncBook(api, "whiteboard", "book", undefined, { ...options, manual: true, requestChoice: async (conflict, lifecycle) => {
      lifecycle.onMounted(); expect(conflict.lifecycle).toBe(true); expect(conflict.pages).toEqual([]); return { lifecycle: "local" };
    } });
    expect(result.status).toBe("synced"); expect(remote.state).toBe("gone"); expect((await getBookSyncState("whiteboard", "book"))?.lifecycle).toBeNull();
    expect((await listRecoveryCopies()).some(copy => copy.type === "record" && copy.record?.ink?.some(row => row.pageId === 44))).toBe(true);
  });
  it("retains a live local copy when another device deleted its hub book", async () => {
    await initial(); const before = await captureBook({ kind: "whiteboard", id: "book" });
    remote = { ...remote, state: "gone", record: null, record_rev: 0, record_hash: null, pages: [], gone_seq: 1, book_rev: ++revision };
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).error?.kind).toBe("gone");
    expect(await captureBook({ kind: "whiteboard", id: "book" })).toEqual(before);
  });
  it.each(["local", "server", "merged"] as const)("restores retained gone ink with actual revisions after an explicit %s choice", async choice => {
    await initial(); await remotePage(113, drawing()); await remotePage(44, empty);
    const retained = remote.pages;
    remote = { ...remote, state: "gone", gone_seq: 4, record: null, record_hash: null, record_rev: 0, pages: [], retained_restore_pages: retained, book_rev: ++revision };
    await mutateLocalBook({ kind: "whiteboard", id: "book" }, { requireIdb: true }, ctx => { ctx.markLifecycle("restore", 5, remote.book_rev, 4); });
    vi.mocked(api.commitPad).mockClear();
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("needs_choice");
    const requestChoice = vi.fn(async (conflict: BookConflict, lifecycle: ConflictUiLifecycle) => { lifecycle.onMounted(); return {
      pages: conflict.pages.map(page => ({ key: page.key, pageId: page.page_id, choice: page.page_id === 44 ? "server" as const : choice })) }; });
    const result = await syncBook(api, "whiteboard", "book", undefined, { ...options, manual: true, requestChoice });
    expect(result.status).toBe("synced"); expect(requestChoice).toHaveBeenCalledOnce();
    const body = vi.mocked(api.commitPad).mock.calls[0]![0]; expect(body.action).toBe("restore");
    for (const page of retained) expect(body.pages.find(item => item.page_id === page.page_id)?.base_rev).toBe(page.rev);
    expect((await listRecoveryCopies()).some(copy => copy.provenance.source === "retained-restore-with-local-parent" && copy.record?.ink?.some(row => row.pageId === 44))).toBe(true);
  });
  it("converts local inline-only ink completely before stripping it from the committed record", async () => {
    await saveWhiteboardNotebook({ id: "book", title: "Book", pageCount: 1, board: { ...board, inkC: drawing() } });
    const original = (await captureBook({ kind: "whiteboard", id: "book" })).payload;
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("synced");
    expect(remote.pages.map(page => page.page_id)).toEqual([1]); expect((remote.record!.board as Record<string, unknown>).inkC).toBeUndefined();
    expect((await encodedFromRecord((await getInkPageRecord("wb:book", 1))!))?.ops).toEqual(drawing().ops);
    expect((await listRecoveryCopies()).some(copy => copy.record?.payload && JSON.stringify(copy.record.payload) === JSON.stringify(original))).toBe(true);
  });
  it("converts a hub inline-only book with an atomic staged commit and retains its original wire record", async () => {
    await remoteRecord("Legacy book"); remote.record = { ...remote.record!, board: { ...board, inkC: JSON.parse(JSON.stringify(drawing())) } };
    remote.record_hash = await recordHash(remote.record);
    expect((await syncBook(api, "whiteboard", "book", undefined, { ...options, allowCreate: true })).status).toBe("synced");
    expect(remote.pages.map(page => page.page_id)).toEqual([1]); expect((remote.record!.board as Record<string, unknown>).inkC).toBeUndefined();
    expect((await getBookSyncState("whiteboard", "book"))?.appliedBookRev).toBe(remote.book_rev);
    expect((await listRecoveryCopies()).some(copy => (copy.record?.payload.board as { inkC?: unknown } | undefined)?.inkC)).toBe(true);
  });
  it("reports missing local manifested ink and retains the complete original record", async () => {
    await saveWhiteboardNotebook({ id: "book", title: "Book", pageCount: 1, board: { ...board, inkPages: { v: 1, pageIds: [113] } } });
    const before = await captureBook({ kind: "whiteboard", id: "book" });
    const result = await syncBook(api, "whiteboard", "book", undefined, options);
    expect(result.error?.kind).toBe("local_page"); expect(result.error?.pages).toEqual([{ key: "book", pageId: 113 }]); expect(api.commitPad).not.toHaveBeenCalled();
    expect(await captureBook({ kind: "whiteboard", id: "book" })).toEqual(before);
  });
  it.each(["pages", "inline"] as const)("retains divergent inline/shard versions and explicitly restores the %s choice", async choice => {
    await saveWhiteboardNotebook({ id: "book", title: "Book", pageCount: 1, board: { ...board, inkC: drawing("#aa0000") } });
    await putInkPages("wb:book", [[1, drawing("#0000aa")]]);
    const original = await captureBook({ kind: "whiteboard", id: "book" });
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("needs_choice");
    expect(await captureBook({ kind: "whiteboard", id: "book" })).toEqual(original); expect(api.commitPad).not.toHaveBeenCalled();
    const copies = await listRecoveryCopies();
    const selected = copies.find(copy => copy.provenance.source === (choice === "pages" ? "legacy-saved-page-choice" : "legacy-inline-page-choice"))!;
    expect(copies.filter(copy => copy.type === "record")).toHaveLength(2);
    await restoreRetainedRecord(selected.id);
    expect((await syncBook(api, "whiteboard", "book", undefined, options)).status).toBe("synced");
    expect((await encodedFromRecord((await getInkPageRecord("wb:book", 1))!))!.ops[0]!.c).toBe(choice === "pages" ? "#0000aa" : "#aa0000");
    expect((await listRecoveryCopies()).some(copy => copy.id === selected.id)).toBe(true);
  });
  it("a recovered older receipt cannot regress an already published baseline", async () => {
    await initial(); const captured = await captureBook({ kind: "whiteboard", id: "book" });
    const old = [...receipts.values()][0]!;
    const oldPage = captured.pages[0]!;
    const attempt = { uploadId: old.upload_id, requestHash: "old", record: { capturedSeq: captured.state.syncedChangeSeq,
      wireHash: old.book.record_hash!, localHash: captured.state.baseRecordLocalHash! },
      pages: [{ key: "book", pageId: 113, capturedSeq: oldPage.syncedChangeSeq!, wireHash: oldPage.baseWireHash!, localHash: oldPage.baseLocalHash! }], lifecycleToken: null };
    await putInkPages("wb:book", [[113, different()]]); await renameWhiteboardNotebook("book", "Later");
    await syncBook(api, "whiteboard", "book", undefined, options);
    const newer = await captureBook({ kind: "whiteboard", id: "book" });
    await acknowledgeBook(captured, attempt, old);
    expect(await captureBook({ kind: "whiteboard", id: "book" })).toEqual(newer);
  });
  it("a delete acknowledgement cannot clear a newer restore token", async () => {
    await initial();
    await mutateLocalBook({ kind: "whiteboard", id: "book" }, { requireIdb: true }, ctx => { ctx.setMetadata({ ...ctx.metadata!, deletedAt: 1 }); ctx.markLifecycle("delete", 1, remote.book_rev); });
    const captured = await captureBook({ kind: "whiteboard", id: "book" });
    await mutateLocalBook({ kind: "whiteboard", id: "book" }, { requireIdb: true }, ctx => { ctx.setMetadata({ ...ctx.metadata!, deletedAt: undefined }); ctx.markLifecycle("restore", 2, remote.book_rev, 1); });
    const current = await captureBook({ kind: "whiteboard", id: "book" });
    await acknowledgeBook(captured, { uploadId: "delete", requestHash: "delete", record: null, pages: [], lifecycleToken: captured.state.lifecycle!.token },
      { status: "committed", upload_id: "delete", record_rev: null, page_revs: [], book: { ...remote, state: "gone", book_rev: ++revision, gone_seq: 1, record: null, record_hash: null, pages: [] } });
    const after = await captureBook({ kind: "whiteboard", id: "book" });
    expect(after.state.lifecycle).toEqual(current.state.lifecycle); expect(after.metadata?.deletedAt).toBeUndefined(); expect(after.state.syncedChangeSeq).toBe(current.state.syncedChangeSeq);
  });
  it("a cancelled join settles while the original attempt remains coordinated", async () => {
    await save(); let release!: () => void;
    const commit = vi.mocked(api.commitPad).getMockImplementation()!;
    vi.mocked(api.commitPad).mockImplementation(async body => { await new Promise<void>(resolve => { release = resolve; }); return commit(body); });
    const original = syncBook(api, "whiteboard", "book", undefined, options);
    await vi.waitFor(() => expect(release).toBeDefined()); const abort = new AbortController();
    const joined = syncBook(api, "whiteboard", "book", undefined, { ...options, signal: abort.signal }); abort.abort();
    expect((await joined).status).toBe("cancelled"); expect(api.commitPad).toHaveBeenCalledOnce(); release();
    expect((await original).status).toBe("synced");
  });
});
it("classifies independently of candidate sequences and timestamps", () => {
  expect(classifyBookItem("base", "base", "remote", 3, 1)).toBe("download");
  expect(classifyBookItem("local", "base", "base", 1, 1)).toBe("upload");
  expect(classifyBookItem("local", "base", "remote", 3, 1)).toBe("conflict");
  expect(classifyBookItem("same", null, "same", 3, 0)).toBe("equal");
  expect(classifyBookItem("local", null, "remote", 3, 0)).toBe("conflict");
});
