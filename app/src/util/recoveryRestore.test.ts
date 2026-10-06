import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDbForTests, run, STORE_CONTENT } from "./idb";
import { retainRecoveryCopy, listRecoveryCopies, readRecoveryCopy } from "./syncRecovery";
import { restoreRetainedRecord, recoveryExportValue } from "./recoveryRestore";
import { mutateLocalBook, resetLocalBookStoreForTests } from "./localBookStore";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { getBookSyncState } from "./syncState";
import { putInkPages } from "./inkPageStore";
import { encodeInkOps } from "../canvas/inkCodec";
import { migrateLegacyWhiteboard, saveWhiteboardNotebook } from "./whiteboardStore";
import type { RecoveryCopy } from "./syncRecovery";

const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const copy = (): RecoveryCopy => ({ id: "copy", type: "record", kind: "annotate", bookId: "book",
  provenance: { source: "legacy" }, record: { meta: { kind: "annotate", id: "book", name: "Saved.md", hash: "source", docType: "markdown", future: { kept: true } },
    payload: { source: "# retained", board, agent: [{ id: "retained turn" }], footnotes: [], future: { author: true } }, children: { scratch: { board, pageCount: 1 } } } });
beforeEach(async () => {
  await closeDbForTests(); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  resetBookCoordinatorForTests(); resetLocalBookStoreForTests();
});
afterEach(async () => { await closeDbForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("explicit local recovery restore", () => {
  it("retains a legacy single-slot board beside an existing library and is restartable", async () => {
    await saveWhiteboardNotebook({ id: "existing", title: "Current", pageCount: 1, board });
    const original = { ...board, elements: [{ id: "legacy stroke" }] };
    localStorage.setItem("lc.scratchpad.board.v1", JSON.stringify(original));
    localStorage.setItem("lc.scratchpad.agent.v1", JSON.stringify([{ id: "legacy conversation" }]));
    await migrateLegacyWhiteboard(() => 1); await migrateLegacyWhiteboard(() => 1);
    const copies = await listRecoveryCopies(); expect(copies).toHaveLength(1);
    expect(copies[0]?.record?.payload).toEqual({ board: original, agent: [{ id: "legacy conversation" }] });
    expect(localStorage.getItem("lc.scratchpad.board.v1")).toBe(JSON.stringify(original));
    expect(await run(STORE_CONTENT, "readonly", store => store.get("existing"))).toMatchObject({ board });
  });

  it("restores a complete missing-parent record and children while retaining the source copy", async () => {
    const original = copy(); await retainRecoveryCopy(original);
    expect(await restoreRetainedRecord(original.id)).toEqual({ kind: "annotate", id: "book" });
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toEqual(original.record!.payload);
    expect(await run(STORE_CONTENT, "readonly", store => store.get("fnwb:book:scratch"))).toEqual(original.record!.children!.scratch);
    expect(await readRecoveryCopy(original.id)).toEqual(original);
    expect(await getBookSyncState("annotate", "book")).toMatchObject({ bootstrap: true, syncedChangeSeq: 0 });
  });
  it("retains the losing complete current record, children and handwriting before replacement", async () => {
    await mutateLocalBook({ kind: "annotate", id: "book" }, {}, ctx => {
      ctx.setMetadata({ kind: "annotate", id: "book", name: "Current", hash: "source", locked: true });
      ctx.setContent({ source: "current", board, agent: [{ id: "current turn" }] });
    });
    await run(STORE_CONTENT, "readwrite", store => store.put({ board, future: "child" }, "fnwb:book:other"));
    await putInkPages("fnwb:book:other", [[1, encodeInkOps([])]]);
    await retainRecoveryCopy(copy()); await restoreRetainedRecord("copy");
    const losing = (await listRecoveryCopies()).find(row => row.type === "conflict")!;
    expect(losing.content).toMatchObject({ metadata: { locked: true }, payload: { source: "current", agent: [{ id: "current turn" }] },
      children: { "fnwb:book:other": { future: "child" } }, ink: [expect.objectContaining({ docKey: "fnwb:book:other", pageId: 1 })] });
    expect(await readRecoveryCopy("copy")).toEqual(copy());
  });
  it("missing shard dependencies refuse publication and leave the original copy readable", async () => {
    const original = copy(); original.record!.payload.board = { ...board, inkPages: { v: 1, pageIds: [113] } };
    await retainRecoveryCopy(original); await expect(restoreRetainedRecord("copy")).rejects.toThrow("missing handwriting");
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toBeUndefined(); expect(await readRecoveryCopy("copy")).toEqual(original);
  });
  it("a missing referenced scratch board leaves the retained parent unpublished", async () => {
    const original = copy(); original.record!.payload.footnotes = [{ id: "mark", whiteboards: [{ id: "missing" }] }];
    await retainRecoveryCopy(original); await expect(restoreRetainedRecord("copy")).rejects.toThrow("missing scratch board");
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toBeUndefined();
    expect(await readRecoveryCopy("copy")).toEqual(original);
  });
  it("a missing binary source cannot invent a readable recovered document", async () => {
    const original = copy(); original.record!.meta.docType = "pdf";
    await retainRecoveryCopy(original); await expect(restoreRetainedRecord("copy")).rejects.toThrow("source file is missing");
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toBeUndefined(); expect(await readRecoveryCopy("copy")).toEqual(original);
  });
  it("a quota abort publishes neither the recovered content nor a partial losing-copy backup", async () => {
    await retainRecoveryCopy(copy()); const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
      if (this.name === STORE_CONTENT) throw new DOMException("quota", "QuotaExceededError");
      return original.call(this, value, key);
    });
    await expect(restoreRetainedRecord("copy")).rejects.toThrow();
    expect(await run(STORE_CONTENT, "readonly", store => store.get("book"))).toBeUndefined();
    expect(await listRecoveryCopies()).toEqual([copy()]); expect(await getBookSyncState("annotate", "book")).toBeNull();
  });
  it("exports actual binary and typed-array bytes together with unknown fields", async () => {
    const value = { source: "saved", future: { bytes: new Uint16Array([5, 400]) }, original: new Uint8Array([1, 2, 3]).buffer };
    const exported = await recoveryExportValue(value);
    expect(exported).toEqual({ source: "saved", future: { bytes: { type: "Uint16Array", bytes: [...new Uint8Array(value.future.bytes.buffer)] } }, original: { type: "ArrayBuffer", bytes: [1, 2, 3] } });
  });
});
