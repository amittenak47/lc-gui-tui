import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { LcApiError, type LcClient } from "../api/client";
import { savePadHub, setHostLoopback } from "./padHub";
import { beginPadHubStatusRequest, refreshPadHubStatus, reportPadHubStatus } from "./padHubStatus";
import { closeDbForTests, openDb, run, STORE_CONTENT, STORE_SNAPSHOTS, STORE_BYTES } from "./idb";
import { getBookSyncState } from "./syncState";
import { mutateLocalBook, resetLocalBookStoreForTests } from "./localBookStore";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { saveWhiteboardNotebook, getWhiteboardNotebook, trashWhiteboardNotebook } from "./whiteboardStore";
import { saveAnnotateDoc, getAnnotateDoc } from "./annotateStore";
import { putProblemBoard, getProblemBoard, deleteProblemBoard } from "./problemBoardStore";
import { applyPadSyncPing, pushAnnotatePad, pushDocBytes, pushPadSnapshot, pushProblemPad,
  pushWhiteboardPad, resetPadSyncForTests, restoreTrashedPad, syncLegacySnapshots, tombstonePad, waitForPadPushes } from "./padSync";
import { LEGACY_QUEUE_STORE } from "./queueMigration";
import { listRecoveryCopies } from "./syncRecovery";
import { getPadSnapshot, listPadSnapshots } from "./padSnapshotStore";

const HUB = { url: "http://desktop.test:7878", token: "token" };
const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const snapshot = { kind: "whiteboard" as const, key: "w1", tier: "24h" as const, writtenAt: 10, name: "Saved", board };
const notebook = { id: "w1", title: "Saved", pageCount: 1, board };
const annotation = { id: "a1", name: "Note", hash: "source", docType: "markdown" as const, source: "text", board };
const problem = { id: "d/1", dataset: "d", taskId: "1", updatedAt: 10, board, agent: [] };
function status(value: "online" | "offline") { reportPadHubStatus(beginPadHubStatusRequest(HUB), value); }
function client(): LcClient {
  return {
    putWhiteboardPad: vi.fn(async (_id, body) => ({ ...body, updated_at: 50 })),
    putAnnotatePad: vi.fn(async (_id, body) => ({ ...body, updated_at: 50 })),
    putProblemPad: vi.fn(async (_dataset, _task, body) => ({ ...body, updated_at: 50 })),
    putDocBytes: vi.fn(async () => {}), putPadSnapshot: vi.fn(async () => {}),
    tombstoneWhiteboardPad: vi.fn(async () => ({ applied: true, seq: 1 })),
    tombstoneAnnotatePad: vi.fn(async () => ({ applied: true, seq: 1 })),
    tombstoneProblemPad: vi.fn(async () => ({ applied: true, seq: 1 })),
    pingPadSync: vi.fn(async () => ({ now: 50, whiteboard: [], annotate: [], problem: [], snapshots: [], gone: [], ink: [], edges: [] })),
  } as unknown as LcClient;
}
async function saved() {
  await saveWhiteboardNotebook(notebook); await saveAnnotateDoc(annotation); await putProblemBoard(problem);
}
async function state(kind: "annotate" | "whiteboard" | "problem", id: string) { return (await getBookSyncState(kind, id))!; }
async function migration(jobs: Record<string, unknown>[], extra: Array<[string, string, unknown]> = []) {
  await closeDbForTests();
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("whiteboard.docs", 7);
    req.onupgradeneeded = () => { for (const name of ["bytes", "content", "snapshots", "ink_pages", "offline_boards", "problem_boards", "note_links", LEGACY_QUEUE_STORE]) req.result.createObjectStore(name); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = old.transaction([LEGACY_QUEUE_STORE, ...new Set(extra.map(([name]) => name))], "readwrite");
    for (const job of jobs) tx.objectStore(LEGACY_QUEUE_STORE).put(job, String(job.id));
    for (const [name, key, value] of extra) tx.objectStore(name).put(value, key);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  old.close(); return openDb();
}
beforeEach(async () => {
  await closeDbForTests();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key), clear: () => values.clear() });
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  resetPadSyncForTests(); resetLocalBookStoreForTests(); resetBookCoordinatorForTests();
  setHostLoopback(null); savePadHub(HUB); refreshPadHubStatus(); status("offline");
});
afterEach(async () => { await closeDbForTests(); savePadHub(null); refreshPadHubStatus(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("offline current-state sync and legacy recovery", () => {
  it("retains every kind of saved write without requests or a false acknowledgement", async () => {
    await saved(); const api = client();
    await pushWhiteboardPad(api, (await getWhiteboardNotebook("w1"))!);
    await pushAnnotatePad(api, (await getAnnotateDoc("a1"))!); await pushProblemPad(api, problem);
    await pushDocBytes(api, "bytes", new ArrayBuffer(4));
    await expect(pushPadSnapshot(api, snapshot)).rejects.toThrow("kept");
    for (const method of [api.putWhiteboardPad, api.putAnnotatePad, api.putProblemPad, api.putDocBytes, api.putPadSnapshot]) expect(method).not.toHaveBeenCalled();
    for (const [kind, id] of [["whiteboard", "w1"], ["annotate", "a1"], ["problem", "d/1"]] as const) expect(await state(kind, id)).toMatchObject({ syncedChangeSeq: 0, bootstrap: true });
    expect(await run(STORE_BYTES, "readonly", store => store.get("bytes"))).toBeInstanceOf(ArrayBuffer);
  });
  it("recovery health reports cannot replay a saved body while autosync is off", async () => {
    await saved(); const api = client(); await pushProblemPad(api, problem); status("online"); status("online");
    await Promise.resolve(); expect(api.putProblemPad).not.toHaveBeenCalled(); expect(await getProblemBoard(problem.id)).toMatchObject(problem);
  });
  it("a durable deletion survives resetting all in-memory state", async () => {
    await tombstonePad(client(), "whiteboard", "w1", 5); resetPadSyncForTests(); await closeDbForTests();
    expect(await state("whiteboard", "w1")).toMatchObject({ lifecycle: { action: "delete", seq: 5 } });
  });
  it("persists deletion before an online request that never answers", async () => {
    const api = client(); let release!: (value: { applied: boolean; seq: number }) => void;
    vi.mocked(api.tombstoneWhiteboardPad).mockImplementation(() => new Promise(resolve => { release = resolve; })); status("online");
    const pending = tombstonePad(api, "whiteboard", "w1", 5);
    await vi.waitFor(() => expect(api.tombstoneWhiteboardPad).toHaveBeenCalledOnce());
    expect((await state("whiteboard", "w1")).lifecycle?.seq).toBe(5); release({ applied: false, seq: 5 }); await pending;
  });
  it("a refused old deletion keeps a reopened board and its newer lifecycle", async () => {
    await saved(); const api = client(); status("online");
    let release!: (value: { applied: boolean; seq: number }) => void;
    vi.mocked(api.tombstoneWhiteboardPad).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = tombstonePad(api, "whiteboard", "w1", 5); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await mutateLocalBook({ kind: "whiteboard", id: "w1" }, {}, ctx => ctx.markLifecycle("restore", 6));
    const newer = (await state("whiteboard", "w1")).lifecycle; release({ applied: false, seq: 5 }); await pending;
    expect((await state("whiteboard", "w1")).lifecycle).toEqual(newer); expect(await getWhiteboardNotebook("w1")).not.toBeNull();
  });
  it("a newer hub save does not silently rebase a refused deletion", async () => {
    const api = client(); status("online"); vi.mocked(api.tombstoneWhiteboardPad).mockResolvedValue({ applied: false, seq: 20 });
    await tombstonePad(api, "whiteboard", "w1", 5);
    expect(api.tombstoneWhiteboardPad).toHaveBeenCalledTimes(1); expect((await state("whiteboard", "w1")).lifecycle?.seq).toBe(5);
  });
  it("a deletion response changing reachability starts no duplicate mutation", async () => {
    const api = client(); status("online"); vi.mocked(api.tombstoneWhiteboardPad).mockImplementation(async () => { status("online"); return { applied: true, seq: 5 }; });
    await tombstonePad(api, "whiteboard", "w1", 5); expect(api.tombstoneWhiteboardPad).toHaveBeenCalledOnce();
  });
  it("a response without applied:true retains the deletion intent", async () => {
    const api = client(); status("online"); vi.mocked(api.tombstoneWhiteboardPad).mockResolvedValue(undefined as never);
    await tombstonePad(api, "whiteboard", "w1", 5); expect((await state("whiteboard", "w1")).lifecycle?.action).toBe("delete");
  });
  it("offline reopened problem content is retained without reachability recovery writes", async () => {
    await putProblemBoard(problem); await deleteProblemBoard(problem.id); await putProblemBoard({ ...problem, updatedAt: 30 });
    status("online"); await Promise.resolve(); expect(await getProblemBoard(problem.id)).toMatchObject({ updatedAt: 30 });
    expect((await state("problem", problem.id)).syncedChangeSeq).toBe(0);
    expect((await state("problem", problem.id)).lifecycle?.action).toBe("restore");
  });
  it("a later local save remains dirty while an older explicit upload waits", async () => {
    await saved(); const api = client(); status("online"); let release!: () => void;
    vi.mocked(api.putWhiteboardPad).mockImplementation(async (_id, body) => { await new Promise<void>(resolve => { release = resolve; }); return body; });
    const pending = pushWhiteboardPad(api, (await getWhiteboardNotebook("w1"))!); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await saveWhiteboardNotebook({ ...notebook, board: { ...board, elements: [{ id: "new" }] } });
    const covered = (await state("whiteboard", "w1")).changeSeq; release(); await pending;
    expect((await state("whiteboard", "w1")).syncedChangeSeq).toBeLessThan(covered);
    expect((await getWhiteboardNotebook("w1"))?.board.elements).toEqual([{ id: "new" }]);
  });
  it("a current acknowledged alternative cannot erase a retained queue-only problem copy", async () => {
    await migration([{ id: "q-1-a", op: "putProblem", body: { id: "d/1", dataset: "d", task_id: "1", updated_at: 10, board: { ...board, elements: [{ id: "unsent" }] }, agent: [] } }]);
    await putProblemBoard({ ...problem, updatedAt: 50, hubAckUpdatedAt: 50 });
    const copies = await listRecoveryCopies("problem", "d/1"); expect(copies).toHaveLength(1);
    expect(copies[0]?.record?.payload.board).toMatchObject({ elements: [{ id: "unsent" }] });
  });
  it("a pending explicit upload wait releases when the hub is detected offline", async () => {
    await saved(); const api = client(); status("online"); let release!: () => void;
    vi.mocked(api.putWhiteboardPad).mockImplementation(async (_id, body) => { await new Promise<void>(resolve => { release = resolve; }); return body; });
    const pending = pushWhiteboardPad(api, (await getWhiteboardNotebook("w1"))!); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const waiting = waitForPadPushes("whiteboard", "w1"); status("offline"); await waiting; release(); await pending;
  });
  it("failed durable replacement preserves the previous saved content and tracking", async () => {
    await saved(); const before = await state("whiteboard", "w1");
    await expect(mutateLocalBook({ kind: "whiteboard", id: "w1" }, { requireIdb: true }, ctx => { ctx.setContent({ source: "replacement" }); throw new Error("quota"); })).rejects.toThrow("quota");
    expect(await getWhiteboardNotebook("w1")).toMatchObject(notebook); expect(await state("whiteboard", "w1")).toEqual(before);
  });
  it("required deletion persistence failure keeps the previous intent", async () => {
    await tombstonePad(client(), "whiteboard", "w1", 5); const before = await state("whiteboard", "w1");
    await expect(mutateLocalBook({ kind: "whiteboard", id: "w1" }, { requireIdb: true }, ctx => { ctx.markLifecycle("delete", 6); throw new Error("quota"); })).rejects.toThrow("quota");
    expect(await state("whiteboard", "w1")).toEqual(before);
  });
  it("clearing an old problem never discards a newer complete recovery alternative", async () => {
    await migration([{ id: "q-1-a", op: "putProblem", body: { id: "d/1", dataset: "d", task_id: "1", updated_at: 30, board, agent: [{ id: "newer" }] } }, { id: "q-1-b", op: "deletePad", kind: "problem", padId: "d/1", seq: 2 }]);
    const copy = (await listRecoveryCopies("problem", "d/1"))[0]!; expect(copy.record?.payload.agent).toEqual([{ id: "newer" }]);
    expect((await state("problem", "d/1")).lifecycle?.action).toBe("delete");
  });
  it("an old success cannot clear a newer restored lifecycle token", async () => {
    const api = client(); status("online"); let release!: () => void;
    vi.mocked(api.tombstoneWhiteboardPad).mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { applied: true, seq: 1 }; });
    const pending = tombstonePad(api, "whiteboard", "w1", 1); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await mutateLocalBook({ kind: "whiteboard", id: "w1" }, {}, ctx => ctx.markLifecycle("restore", 2)); const token = (await state("whiteboard", "w1")).lifecycle?.token;
    release(); await pending; expect((await state("whiteboard", "w1")).lifecycle).toMatchObject({ action: "restore", token });
  });
  it("failed local restore retains the deletion and the saved scene", async () => {
    await saved(); await trashWhiteboardNotebook("w1"); await run(STORE_CONTENT, "readwrite", store => store.delete("w1"));
    const before = (await state("whiteboard", "w1")).lifecycle; expect(await restoreTrashedPad(client(), "whiteboard", "w1")).toEqual({ ok: false });
    expect((await state("whiteboard", "w1")).lifecycle).toEqual(before);
  });
  it("409 and 410 failures keep current records while unrelated bytes still transfer", async () => {
    await saved(); const api = client(); status("online");
    vi.mocked(api.putWhiteboardPad).mockRejectedValue(new LcApiError("conflict", 409));
    expect(await pushWhiteboardPad(api, (await getWhiteboardNotebook("w1"))!)).toBe(false);
    await pushDocBytes(api, "h", new ArrayBuffer(4)); expect(api.putDocBytes).toHaveBeenCalledOnce();
    vi.mocked(api.putWhiteboardPad).mockRejectedValue(new LcApiError("gone", 410));
    expect(await pushWhiteboardPad(api, (await getWhiteboardNotebook("w1"))!)).toBe(false); expect(await getWhiteboardNotebook("w1")).not.toBeNull();
  });
  it.each([["whiteboard", 409], ["whiteboard", 410], ["annotate", 409], ["annotate", 410], ["problem", 409], ["problem", 410]] as const)("preserves offline %s work when a foreground transfer returns %s", async (kind, code) => {
    await saved(); const api = client(); status("online");
    const current = kind === "whiteboard" ? await getWhiteboardNotebook("w1") : kind === "annotate" ? await getAnnotateDoc("a1") : await getProblemBoard("d/1");
    for (const method of [api.putWhiteboardPad, api.putAnnotatePad, api.putProblemPad]) vi.mocked(method).mockRejectedValue(new LcApiError("rejected", code));
    const result = kind === "whiteboard" ? await pushWhiteboardPad(api, current as never) : kind === "annotate" ? await pushAnnotatePad(api, current as never) : await pushProblemPad(api, current as never);
    expect(result).toBe(false); const next = kind === "whiteboard" ? await getWhiteboardNotebook("w1") : kind === "annotate" ? await getAnnotateDoc("a1") : await getProblemBoard("d/1");
    expect(next).toEqual(current); expect((await state(kind, current!.id)).syncedChangeSeq).toBe(0);
  });
  it("serialized explicit retries read a replacement saved during the first request", async () => {
    await saved(); const api = client(); status("online"); let release!: () => void;
    vi.mocked(api.putWhiteboardPad).mockImplementationOnce(async (_id, body) => { await new Promise<void>(resolve => { release = resolve; }); return body; });
    const stale = (await getWhiteboardNotebook("w1"))!; const first = pushWhiteboardPad(api, stale); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await saveWhiteboardNotebook({ ...notebook, board: { ...board, elements: [{ id: "latest" }] } }); const second = pushWhiteboardPad(api, stale); release();
    await Promise.all([first, second]); expect(vi.mocked(api.putWhiteboardPad).mock.calls[1]?.[1].board).toMatchObject({ elements: [{ id: "latest" }] });
  });
  it("one explicit current problem attempt makes only one request on 503", async () => {
    await saved(); const api = client(); status("online"); vi.mocked(api.putProblemPad).mockRejectedValue(new LcApiError("unavailable", 503));
    expect(await pushProblemPad(api, problem)).toBe(false); expect(api.putProblemPad).toHaveBeenCalledOnce(); expect(await getProblemBoard(problem.id)).not.toBeNull();
  });
  it("a manual current-state upload uses the newest record with no stale double upload", async () => {
    await saved(); const stale = (await getWhiteboardNotebook("w1"))!; await saveWhiteboardNotebook({ ...notebook, title: "Newest", metadataIntent: "rename" });
    const api = client(); status("online"); expect(await pushWhiteboardPad(api, stale)).toBe(true);
    expect(api.putWhiteboardPad).toHaveBeenCalledOnce(); expect(vi.mocked(api.putWhiteboardPad).mock.calls[0]?.[1].title).toBe("Newest");
  });
  it("migration retains every backup and byte while folding only current lifecycle intent", async () => {
    const bytes = new Uint8Array([1, 2]).buffer;
    await migration([{ id: "q-1-a", op: "putBytes", hash: "h", bytes }, { id: "q-1-b", op: "putSnapshot", body: { kind: "whiteboard", key: "gone", tier: "24h", written_at: 9, payload: { name: "Backup", board } } }, { id: "q-1-c", op: "deletePad", kind: "whiteboard", padId: "gone", seq: 2 }, { id: "q-1-d", op: "restorePad", kind: "whiteboard", padId: "gone", seq: 3 }]);
    expect(await run(STORE_BYTES, "readonly", store => store.get("h"))).toEqual(bytes); expect(await listPadSnapshots("whiteboard", "gone")).toHaveLength(1);
    expect((await state("whiteboard", "gone")).lifecycle?.action).toBe("restore"); expect(await getWhiteboardNotebook("gone")).toBeNull();
  });
  it("a refused migrated lifecycle retains every independent backup successor", async () => {
    await migration([{ id: "q-1-a", op: "tombstone", kind: "whiteboard", padId: "gone", enqueuedAt: 1 }, { id: "q-1-b", op: "putSnapshot", body: { kind: "whiteboard", key: "gone", tier: "24h", written_at: 10, payload: { name: "Saved", board } } }]);
    expect((await state("whiteboard", "gone")).lifecycle?.action).toBe("delete"); expect(await listPadSnapshots("whiteboard", "gone")).toHaveLength(1);
  });
  it("a legacy deletion retains an unknown head and cannot authorize removing a later hub version", async () => {
    await migration([{ id: "q-1-a", op: "tombstone", kind: "whiteboard", padId: "gone", enqueuedAt: 1 }]);
    expect((await state("whiteboard", "gone")).lifecycle).toMatchObject({ action: "delete", baseBookRev: null });
  });
  it("successful live upload retains newer current edits and all independent backup copies", async () => {
    await saved(); await run(STORE_SNAPSHOTS, "readwrite", store => store.put(snapshot, "whiteboard:w1:24h"));
    const api = client(); status("online"); await pushWhiteboardPad(api, (await getWhiteboardNotebook("w1"))!);
    expect(await getPadSnapshot("whiteboard", "w1", "24h")).toMatchObject(snapshot); expect((await state("whiteboard", "w1")).bootstrap).toBe(true);
  });
  it("autosync off produces no background mutation at startup or recovery", async () => {
    await saved(); localStorage.setItem("whiteboard.hubAutoSync.v1", "off"); const api = client(); status("online"); await applyPadSyncPing(api);
    expect(api.pingPadSync).not.toHaveBeenCalled(); expect(api.putWhiteboardPad).not.toHaveBeenCalled();
  });
  it("a missing-parent immutable backup remains eligible for explicit retry", async () => {
    await run(STORE_SNAPSHOTS, "readwrite", store => store.put(snapshot, "whiteboard:w1:24h")); const api = client(); status("online");
    vi.mocked(api.putPadSnapshot).mockRejectedValueOnce(new Error("missing parent")); await expect(syncLegacySnapshots(api)).rejects.toThrow("missing parent");
    expect(await getPadSnapshot("whiteboard", "w1", "24h")).toMatchObject(snapshot); await syncLegacySnapshots(api); expect(api.putPadSnapshot).toHaveBeenCalledTimes(2);
  });
  it("an unsupported legacy operation aborts migration and keeps its original copy", async () => {
    const original = { id: "q-1-a", op: "unsupported", payload: { keep: true } };
    await expect(migration([original])).rejects.toThrow("Unknown or malformed");
    const old = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("whiteboard.docs"); req.onsuccess = () => resolve(req.result); });
    const copy = await new Promise<unknown>(resolve => { const req = old.transaction(LEGACY_QUEUE_STORE).objectStore(LEGACY_QUEUE_STORE).get(original.id); req.onsuccess = () => resolve(req.result); });
    expect(old.version).toBe(7); expect(copy).toEqual(original); old.close();
  });
});
