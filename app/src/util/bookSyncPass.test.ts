import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./bookSync", async original => ({ ...await original<typeof import("./bookSync")>(), syncBook: vi.fn() }));
vi.mock("./inkSync", async original => ({ ...await original<typeof import("./inkSync")>(), syncEdges: vi.fn(async () => {}) }));
const backups = vi.hoisted(() => new Map<string, import("./padSnapshotStore").PadSnapshot>());
vi.mock("./padSnapshotStore", async original => ({ ...await original<typeof import("./padSnapshotStore")>(),
  listAllPadSnapshots: vi.fn(async () => [...backups.values()]), getPadSnapshot: vi.fn(async (_kind, _key, _tier, id) => backups.get(id) ?? null) }));
import type { LcClient, PadSyncPingDto, BookStateDto } from "../api/client";
import { syncBookPass } from "./bookSyncPass";
import { syncBook, BookSyncError, type BookResult } from "./bookSync";
import { closeDbForTests } from "./idb";
import { saveWhiteboardNotebook } from "./whiteboardStore";
import { putProblemBoard } from "./problemBoardStore";
import { resetLocalBookStoreForTests, mutateLocalBook } from "./localBookStore";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { saveHubAutosyncPref } from "./hubAutoSyncPref";

const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const inventory = (id: string, rev = 1): BookStateDto => ({ kind: "whiteboard", id, book_rev: rev, record_rev: 1, state: "live", gone_seq: null, record_hash: "record", record: { id, title: id, board }, pages: [] });
let api: LcClient, ping: PadSyncPingDto;
beforeEach(async () => {
  await closeDbForTests(); resetLocalBookStoreForTests(); resetBookCoordinatorForTests(); backups.clear(); vi.clearAllMocks();
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return storage.size; }, key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("navigator", { locks: { request: (_key: string, work: () => Promise<unknown>) => work() } });
  ping = { features: ["atomic_book_sync_v1"], books: [], now: 1, whiteboard: [], annotate: [], problem: [], gone: [], snapshots: [], ink: [], edges: [], gone_edges: [] };
  api = { pingPadSync: vi.fn(async () => ping), listSnapshotCopies: vi.fn(async () => []), putSnapshotCopy: vi.fn(async () => ({ stored: true })) } as unknown as LcClient;
  vi.mocked(syncBook).mockImplementation(async (_client, kind, id) => ({ kind, id, status: "synced", committed: true }));
});
afterEach(async () => { await closeDbForTests(); resetLocalBookStoreForTests(); vi.unstubAllGlobals(); });
const save = (id: string) => saveWhiteboardNotebook({ id, title: id, board, pageCount: 1 });

it("pings once, opens the selected book first, deduplicates and continues after failure", async () => {
  await save("a"); await save("b"); ping.books = [inventory("a"), inventory("b")];
  vi.mocked(syncBook).mockImplementation(async (_client, kind, id) => ({ kind, id, committed: false, status: id === "b" ? "failed" : "synced", ...(id === "b" ? { error: new BookSyncError("stage", "failed") } : {}) }));
  const progress = vi.fn(); const result = await syncBookPass(api, { selected: { kind: "whiteboard", id: "b" }, onProgress: progress });
  expect(api.pingPadSync).toHaveBeenCalledOnce(); expect(result.books.map(book => book.id)).toEqual(["b", "a"]);
  expect(progress.mock.calls.map(([done, total]) => [done, total])).toEqual([[1, 2], [2, 2]]);
});
it("includes problem records and pending lifecycle while keeping clean books out", async () => {
  await save("clean"); await mutateLocalBook({ kind: "whiteboard", id: "clean" }, { authored: false }, ctx => ctx.setState({ ...ctx.state, bootstrap: false, syncedChangeSeq: ctx.state.changeSeq }));
  await putProblemBoard({ id: "dataset/task", dataset: "dataset", taskId: "task", board, updatedAt: 1 });
  const result = await syncBookPass(api);
  expect(result.books.map(book => [book.kind, book.id])).toEqual([["problem", "dataset/task"]]);
});
it("does not import hub-only books except during explicit Library Pull", async () => {
  ping.books = [inventory("hub-only")];
  expect((await syncBookPass(api)).books).toEqual([]);
  expect((await syncBookPass(api, { libraryPull: true })).books.map(book => book.id)).toEqual(["hub-only"]);
  expect(vi.mocked(syncBook).mock.calls[0]![4]).toMatchObject({ allowCreate: true });
});
it("isolates a broken inventory book and still attempts its healthy neighbour", async () => {
  await save("bad"); await save("good");
  ping.errors = [{ kind: "whiteboard", id: "bad", book_rev: 1, error: { message: "Unreadable hub ink", status: "unreadable_content" } }];
  const result = await syncBookPass(api);
  expect(result.books.filter(book => book.id === "bad")).toHaveLength(1); expect(result.books.find(book => book.id === "bad")?.status).toBe("failed");
  expect(vi.mocked(syncBook).mock.calls.map(call => call[2])).toEqual(["good"]);
});
it("auto-sync off does not prepare, ping or mutate anything in the background", async () => {
  await save("dirty"); const prepare = vi.fn();
  expect((await syncBookPass(api, { silent: true, prepare })).books).toEqual([]);
  expect(prepare).not.toHaveBeenCalled(); expect(api.pingPadSync).not.toHaveBeenCalled(); expect(syncBook).not.toHaveBeenCalled(); expect(api.putSnapshotCopy).not.toHaveBeenCalled();
});
it("manual overlap retries the selected silent conflict interactively", async () => {
  await save("book"); saveHubAutosyncPref("on");
  let release!: (result: BookResult) => void;
  vi.mocked(syncBook).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const silent = syncBookPass(api, { silent: true });
  await vi.waitFor(() => expect(release).toBeDefined());
  const requestChoice = vi.fn(), manual = syncBookPass(api, { selected: { kind: "whiteboard", id: "book" }, requestChoice });
  release({ kind: "whiteboard", id: "book", status: "needs_choice", committed: false });
  await silent; expect((await manual).books[0]?.status).toBe("synced");
  expect(vi.mocked(syncBook).mock.calls[1]![4]).toMatchObject({ manual: true, requestChoice });
});
it("scans immutable backups of clean and missing books and retries only missing hashes", async () => {
  backups.set("copy-a", { snapshotId: "copy-a", kind: "whiteboard", key: "missing", tier: "2h", writtenAt: 1, name: "Missing parent", board });
  backups.set("copy-b", { snapshotId: "copy-b", kind: "whiteboard", key: "missing", tier: "2h", writtenAt: 2, name: "Other copy", board: { ...board, elements: [{ id: "new" }] } });
  const known = new Set<string>();
  vi.mocked(api.listSnapshotCopies).mockImplementation(async () => [...known].map(content_hash => ({ content_hash, tier: "2h", written_at: 1, name: "Backup" })));
  vi.mocked(api.putSnapshotCopy).mockImplementationOnce(async () => { throw new Error("Offline"); });
  vi.mocked(api.putSnapshotCopy).mockImplementation(async (_kind, _id, hash) => { known.add(hash); return { content_hash: hash, tier: "2h", written_at: 1, name: "Backup" }; });
  expect((await syncBookPass(api)).notices.filter(notice => notice.kind === "backup")).toHaveLength(1);
  expect(backups.size).toBe(2); expect(syncBook).not.toHaveBeenCalled();
  expect((await syncBookPass(api)).notices).toEqual([]); expect(api.putSnapshotCopy).toHaveBeenCalledTimes(3); expect(known.size).toBe(2);
  await syncBookPass(api); expect(api.putSnapshotCopy).toHaveBeenCalledTimes(3);
});
it("old hubs get one update notice and never use fabricated modern baselines", async () => {
  await save("book"); ping.features = ["atomic_commit"];
  expect((await syncBookPass(api)).notices).toEqual([{ kind: "old_hub" }]); expect((await syncBookPass(api)).notices).toEqual([]);
  expect(syncBook).not.toHaveBeenCalled(); expect(api.putSnapshotCopy).not.toHaveBeenCalled();
});
