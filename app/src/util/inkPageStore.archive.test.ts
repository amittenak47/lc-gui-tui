import { IDBFactory, IDBKeyRange as FakeKeyRange, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeInkOps } from "../canvas/inkCodec";
import { markInkPageSynced, putInkPageArchive, putInkPages, getInkPageRecord,
  copyInkPages, renameInkPages, deleteInkPages, authoredInkRow, type InkPageRecord } from "./inkPageStore";
import { closeDbForTests, openDb, run, STORE_INK_PAGES, STORE_SYNC_STATE } from "./idb";
import { getBookSyncState } from "./syncState";
import { resetBookCoordinatorForTests } from "./bookCoordinator";

beforeEach(async () => {
  await closeDbForTests(); resetBookCoordinatorForTests();
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", FakeKeyRange);
});
afterEach(async () => { await closeDbForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const encoded = encodeInkOps([]);
const row = () => getInkPageRecord("wb:test", 1);

describe("ink archive and sync revisions", () => {
  it("archives without changing the authored revision or losing its hub ack", async () => {
    await putInkPages("wb:test", [[1, encoded]], { now: 100 });
    await markInkPageSynced("wb:test", 1, 100);
    const before = (await row())!;
    const db = await openDb(), transaction = vi.spyOn(db, "transaction");
    expect(await putInkPageArchive("wb:test", 1, new Uint8Array([7]), 100)).toBe(true);
    expect(transaction).toHaveBeenCalledOnce();
    expect(await row()).toMatchObject({ updatedAt: 100, syncedUpdatedAt: 100, dirty: false,
      changeSeq: before.changeSeq, syncedChangeSeq: before.changeSeq, bootstrap: true });
    expect((await row())?.inkC).toBeUndefined();
  });

  it("preserves a newer stroke while an older page is being compressed", async () => {
    await putInkPages("wb:test", [[1, encoded]], { now: 100 });
    await putInkPages("wb:test", [[1, encoded]], { now: 200 });
    expect(await putInkPageArchive("wb:test", 1, new Uint8Array([7]), 100)).toBe(false);
    expect(await row()).toMatchObject({ updatedAt: 200, dirty: true, inkC: encoded });
  });

  it("keeps a stroke arriving during upload dirty and advances only the sent revision", async () => {
    await putInkPages("wb:test", [[1, encoded]], { now: 100 });
    await markInkPageSynced("wb:test", 1, 100);
    const acknowledged = (await row())!.changeSeq;
    await putInkPages("wb:test", [[1, encoded]], { now: 200 });
    await putInkPages("wb:test", [[1, encoded]], { now: 300 });
    await markInkPageSynced("wb:test", 1, 200);
    expect(await row()).toMatchObject({ updatedAt: 300, syncedUpdatedAt: 200,
      syncedChangeSeq: acknowledged, dirty: true });
    await markInkPageSynced("wb:test", 1, 100);
    expect((await row())?.syncedUpdatedAt).toBe(200);
    expect((await row())!.changeSeq).toBeGreaterThan(acknowledged!);
  });

  it("distinguishes two writes in the same clock millisecond", async () => {
    await putInkPages("wb:test", [[1, encoded]], { now: 100 });
    const first = (await row())!;
    await putInkPages("wb:test", [[1, encoded]], { now: 100 });
    expect((await row())?.updatedAt).toBe(101);
    expect((await row())!.changeSeq).toBeGreaterThan(first.changeSeq!);
    expect(await putInkPageArchive("wb:test", 1, new Uint8Array([7]), 100)).toBe(false);
  });

  it("tracks empty and footnote writes and their parent in the same transaction", async () => {
    await putInkPages("fnwb:parent:child", [[0, encoded], [113, encoded]], { now: 100 });
    const pages = await Promise.all([getInkPageRecord("fnwb:parent:child", 0), getInkPageRecord("fnwb:parent:child", 113)]);
    const parent = (await getBookSyncState("annotate", "parent"))!;
    expect(pages[0]).toMatchObject({ bootstrap: true, syncedChangeSeq: 0, syncedRev: 0, baseWireHash: null, baseLocalHash: null });
    expect(pages[1]!.changeSeq).toBeGreaterThan(pages[0]!.changeSeq!);
    expect(parent.changeSeq).toBe(pages[1]!.changeSeq);
    expect(parent.syncedChangeSeq).toBe(0);
  });

  it("rolls the ink and sequence allocation back when quota fails after a row succeeds", async () => {
    await putInkPages("wb:test", [[1, encoded]], { now: 100 });
    const before = await row(), state = await getBookSyncState("whiteboard", "test");
    const counter = await run(STORE_SYNC_STATE, "readonly", store => store.get("__seq"));
    const put = FakeObjectStore.prototype.put;
    vi.spyOn(FakeObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (this.name === STORE_INK_PAGES) request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(putInkPages("wb:test", [[1, encoded]], { now: 200 })).rejects.toThrow();
    expect(await row()).toEqual(before);
    expect(await getBookSyncState("whiteboard", "test")).toEqual(state);
    expect(await run(STORE_SYNC_STATE, "readonly", store => store.get("__seq"))).toEqual(counter);
  });

  it("copies to an unknown base and refuses divergent destinations while keeping both", async () => {
    await putInkPages("wb:source", [[1, encoded]], { now: 100 });
    await markInkPageSynced("wb:source", 1, 100);
    expect(await copyInkPages("wb:source", "wb:copy")).toBe(1);
    const copy = (await getInkPageRecord("wb:copy", 1))!;
    expect(copy).toMatchObject({ bootstrap: true, syncedChangeSeq: 0, syncedRev: 0, baseWireHash: null });
    expect(copy.syncedUpdatedAt).toBeUndefined();
    const source = (await getInkPageRecord("wb:source", 1))!;
    expect(copy.changeSeq).toBeGreaterThan(source.changeSeq!);
    // A different valid layout changes content identity without inventing ink.
    await putInkPages("wb:copy", [[1, { ...encoded, layout: { w: 500, spread: false } }]], { now: copy.updatedAt + 1 });
    const different = await getInkPageRecord("wb:copy", 1);
    await expect(renameInkPages("wb:source", "wb:copy")).rejects.toThrow("both copies were kept");
    expect(await getInkPageRecord("wb:source", 1)).toEqual(source);
    expect(await getInkPageRecord("wb:copy", 1)).toEqual(different);
  });

  it("renames atomically, and erasing retains a tracked readable row", async () => {
    await putInkPages("md:old", [[113, encoded]], { now: 100 });
    expect(await renameInkPages("md:old", "md:new")).toBe(1);
    expect(await getInkPageRecord("md:old", 113)).toBeNull();
    const copied = (await getInkPageRecord("md:new", 113))!;
    await deleteInkPages("md:new");
    const erased = (await getInkPageRecord("md:new", 113))!;
    expect(erased.inkC).toEqual(encoded);
    expect(erased.changeSeq).toBeGreaterThan(copied.changeSeq!);
    expect((await getBookSyncState("annotate", "new"))!.changeSeq).toBe(erased.changeSeq);
  });

  it("authored replacement retains exact wire/local bases independently", () => {
    const previous: InkPageRecord = { v: 1, docKey: "wb:test", pageId: 1, dirty: false, updatedAt: 1,
      changeSeq: 8, syncedChangeSeq: 8, syncedRev: 14, baseWireHash: "wire", baseLocalHash: "local", bootstrap: false };
    expect(authoredInkRow({ ...previous, inkC: encoded, dirty: true }, previous, 9)).toMatchObject({
      changeSeq: 9, syncedChangeSeq: 8, syncedRev: 14, baseWireHash: "wire", baseLocalHash: "local", bootstrap: false });
  });
});
