import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { closeDbForTests, run, STORE_CONTENT } from "./idb";
import { mutateLocalBook, promoteBookFallbacks, chooseRetainedFallbackBranch, listBookFallbacks, resetLocalBookStoreForTests } from "./localBookStore";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { listRecoveryCopies } from "./syncRecovery";
import { getBookSyncState } from "./syncState";

afterEach(async () => { await closeDbForTests(); resetLocalBookStoreForTests(); resetBookCoordinatorForTests(); vi.unstubAllGlobals(); });
it("requires an explicit branch choice, archives both spills, and can choose the other retained branch later", async () => {
  await closeDbForTests(); resetLocalBookStoreForTests(); resetBookCoordinatorForTests();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal("navigator", {}); vi.stubGlobal("indexedDB", undefined); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const owner = { kind: "annotate" as const, id: "book" };
  const save = (source: string) => mutateLocalBook(owner, {}, ctx => {
    ctx.setMetadata({ ...owner, name: source, hash: "source", docType: "markdown" });
    ctx.setContent({ source, future: { kept: true }, board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } } });
  });
  await save("Branch A"); resetBookCoordinatorForTests(); resetLocalBookStoreForTests(); await save("Branch B");
  vi.stubGlobal("indexedDB", new IDBFactory());
  await expect(promoteBookFallbacks(owner)).rejects.toThrow("Saved local copies differ");
  const branches = await listRecoveryCopies(); expect(branches).toHaveLength(2);
  const first = branches.find(copy => (copy.content as { payload: { source: string } }).payload.source === "Branch A")!;
  const second = branches.find(copy => copy.id !== first.id)!;
  await chooseRetainedFallbackBranch(first.id);
  expect(listBookFallbacks()).toEqual([]);
  expect(await run(STORE_CONTENT, "readonly", store => store.get(owner.id))).toMatchObject({ source: "Branch A", future: { kept: true } });
  const state = (await getBookSyncState(owner.kind, owner.id))!; expect(state.changeSeq).toBeGreaterThan(state.syncedChangeSeq);
  await chooseRetainedFallbackBranch(second.id);
  expect(await run(STORE_CONTENT, "readonly", store => store.get(owner.id))).toMatchObject({ source: "Branch B" });
  const copies = await listRecoveryCopies(); expect(copies.some(copy => copy.id === first.id)).toBe(true); expect(copies.some(copy => copy.id === second.id)).toBe(true);
  expect(copies.some(copy => (copy.content as { payload?: { source?: string } }).payload?.source === "Branch A")).toBe(true);
});
