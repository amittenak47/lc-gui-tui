import { IDBFactory, IDBKeyRange as FakeKeyRange, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeInkOps, packEncodedInk } from "../canvas/inkCodec";
import { bytesToB64 } from "../api/nativeHttp";
import { closeDbForTests, run, STORE_BOOK_META, STORE_CONTENT, STORE_INK_PAGES, STORE_SYNC_STATE } from "./idb";
import { mutateLocalBook, resetLocalBookStoreForTests } from "./localBookStore";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { getBookSyncState } from "./syncState";
import { getInkPageRecord, putInkPages } from "./inkPageStore";
import { resetContentRepairForTests } from "./contentStore";
import { restorePadSnapshotLocally } from "./artifactSnapshotRestore";
import type { PadSnapshot } from "./padSnapshotStore";
import { listRecoveryCopies } from "./syncRecovery";

const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const empty = encodeInkOps([]);
const page = (pageId: number, width = 700) => ({ pageId, updatedAt: 12,
  gz: bytesToB64(packEncodedInk({ ...empty, layout: { w: width, spread: false } })) });
const snapshot = (): PadSnapshot => ({ kind: "whiteboard", key: "book", tier: "2h", writtenAt: 12,
  name: "Old book", board, pageCount: 1, agent: ["old thread"], ink: [page(1)] });
beforeEach(async () => {
  await closeDbForTests(); resetLocalBookStoreForTests(); resetBookCoordinatorForTests(); resetContentRepairForTests();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", FakeKeyRange);
});
afterEach(async () => { await closeDbForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function seed(kind: "annotate" | "whiteboard" = "whiteboard") {
  await mutateLocalBook({ kind, id: "book" }, { requireIdb: true }, ctx => {
    ctx.setMetadata({ kind, id: "book", title: "Current book", name: "notes.md", hash: "source", docType: "markdown", updatedAt: 100, pageCount: 2, locked: true });
    ctx.setContent({ board, agent: ["current thread"], source: "# current", footnotes: [] });
  });
}

describe("transactional local snapshot restore", () => {
  it("replaces parent and ink together, empties later pages, and marks exactly one authored version", async () => {
    await seed(); await putInkPages("wb:book", [[1, empty], [2, empty]], { now: 100 });
    const before = (await getBookSyncState("whiteboard", "book"))!;
    await restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, snapshot());
    const meta = await run<Record<string, unknown>>(STORE_BOOK_META, "readonly", store => store.get("whiteboard:book"));
    const content = await run<Record<string, unknown>>(STORE_CONTENT, "readonly", store => store.get("book"));
    const state = (await getBookSyncState("whiteboard", "book"))!;
    expect(meta).toMatchObject({ title: "Old book", locked: true });
    expect(content).toMatchObject({ board, agent: ["old thread"] });
    const losing = await listRecoveryCopies("whiteboard", "book");
    expect(losing).toHaveLength(1);
    expect(losing[0]?.content).toMatchObject({ payload: { agent: ["current thread"] }, ink: [
      expect.objectContaining({ docKey: "wb:book", pageId: 1 }),
      expect.objectContaining({ docKey: "wb:book", pageId: 2 }),
    ] });
    expect(state.changeSeq).toBeGreaterThan(before.changeSeq);
    expect((await getInkPageRecord("wb:book", 1))?.changeSeq).toBe(state.changeSeq);
    expect(await getInkPageRecord("wb:book", 2)).toMatchObject({ inkC: empty, changeSeq: state.changeSeq, syncedChangeSeq: 0 });
  });

  it("a backup with no strokes replaces current ink with a tracked readable erasure", async () => {
    await seed(); await putInkPages("wb:book", [[1, { ...empty, layout: { w: 500, spread: false } }]], { now: 100 });
    await restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, { ...snapshot(), ink: undefined });
    expect(await getInkPageRecord("wb:book", 1)).toMatchObject({ inkC: empty, dirty: true, bootstrap: true });
  });

  it("older inline backup ink is verified and retained rather than replaced by today's rows", async () => {
    await seed(); await putInkPages("wb:book", [[1, empty]], { now: 100 });
    const inline = { ...empty, layout: { w: 500, spread: false } };
    await restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, { ...snapshot(), ink: undefined, board: { ...board, inkC: inline } });
    expect((await getInkPageRecord("wb:book", 1))?.inkC).toEqual(inline);
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toMatchObject({ board: { inkC: inline } });
  });

  it("restores all scratch content and ink atomically, including a backup without source", async () => {
    await seed("annotate"); await putInkPages("fnwb:book:old", [[1, empty]], { now: 100 });
    await run(STORE_CONTENT, "readwrite", store => store.put({ board, pageCount: 1 }, "fnwb:book:old"));
    await restorePadSnapshotLocally({ kind: "annotate", id: "book" }, { ...snapshot(), kind: "annotate", ink: [],
      footnoteBoards: { restored: { board, pageCount: 1 } }, footnoteInk: { restored: [page(1)] } });
    expect(await run(STORE_CONTENT, "readonly", store => store.get("fnwb:book:old"))).toBeUndefined();
    expect(await run(STORE_CONTENT, "readonly", store => store.get("fnwb:book:restored"))).toEqual({ board, pageCount: 1 });
    expect((await getInkPageRecord("fnwb:book:old", 1))?.inkC).toEqual(empty);
    const state = (await getBookSyncState("annotate", "book"))!;
    expect((await getInkPageRecord("fnwb:book:restored", 1))?.changeSeq).toBe(state.changeSeq);
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toMatchObject({ source: "# current" });
  });

  it("restores a retained whiteboard backup after its live parent has been removed", async () => {
    await restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, snapshot());
    expect(await run(STORE_BOOK_META, "readonly", store => store.get("whiteboard:book"))).toMatchObject({ title: "Old book" });
    expect(await getInkPageRecord("wb:book", 1)).toMatchObject({ bootstrap: true, syncedRev: 0, syncedChangeSeq: 0 });
  });

  it("invalid snapshot bytes never clear readable current data", async () => {
    await seed(); await putInkPages("wb:book", [[1, empty]], { now: 100 });
    const current = await getInkPageRecord("wb:book", 1), state = await getBookSyncState("whiteboard", "book");
    await expect(restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, { ...snapshot(), ink: [{ pageId: 1, updatedAt: 1, gz: "YQ==" }] })).rejects.toThrow();
    expect(await getInkPageRecord("wb:book", 1)).toEqual(current);
    expect(await getBookSyncState("whiteboard", "book")).toEqual(state);
  });

  it("unreadable current ink is preserved instead of manufacturing an empty replacement", async () => {
    await seed();
    await run(STORE_INK_PAGES, "readwrite", store => store.put({ v: 1, docKey: "wb:book", pageId: 1, gz: new Uint8Array([1]), dirty: false, updatedAt: 1 }, "wb:book\u001f1"));
    const unreadable = await getInkPageRecord("wb:book", 1);
    await expect(restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, snapshot())).rejects.toThrow("unreadable");
    expect(await getInkPageRecord("wb:book", 1)).toEqual(unreadable);
  });

  it("a late transaction abort rolls parent, child, ink and tracking back together", async () => {
    await seed(); await putInkPages("wb:book", [[1, empty]], { now: 100 });
    const before = await run(STORE_CONTENT, "readonly", store => store.get("book"));
    const metadata = await run(STORE_BOOK_META, "readonly", store => store.get("whiteboard:book"));
    const ink = await getInkPageRecord("wb:book", 1), state = await getBookSyncState("whiteboard", "book");
    const counter = await run(STORE_SYNC_STATE, "readonly", store => store.get("__seq"));
    const put = FakeObjectStore.prototype.put;
    vi.spyOn(FakeObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (this.name === STORE_INK_PAGES) request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(restorePadSnapshotLocally({ kind: "whiteboard", id: "book" }, snapshot())).rejects.toThrow();
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toEqual(before);
    expect(await run(STORE_BOOK_META, "readonly", store => store.get("whiteboard:book"))).toEqual(metadata);
    expect(await getInkPageRecord("wb:book", 1)).toEqual(ink);
    expect(await getBookSyncState("whiteboard", "book")).toEqual(state);
    expect(await run(STORE_SYNC_STATE, "readonly", store => store.get("__seq"))).toEqual(counter);
  });
});
