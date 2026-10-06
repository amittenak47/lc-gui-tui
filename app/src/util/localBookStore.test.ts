import { listRecoveryCopies } from "./syncRecovery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { closeDbForTests, openDb, run, STORE_BOOK_META, STORE_CONTENT, STORE_SYNC_STATE } from "./idb";
import { bookWriterIdentity, resetBookCoordinatorForTests } from "./bookCoordinator";
import { ensureBookReadyForAtomicSync, getCachedBookMeta, hydrateBookMetadata, listBookFallbacks,
  mutateLocalBook, promoteBookFallbacks, readFallbackContent, refreshBookMetadata, resetLocalBookStoreForTests,
  type FallbackBookEnvelope } from "./localBookStore";
import { getBookSyncState, seedSyncState } from "./syncState";

const owner = { kind: "annotate" as const, id: "book" };
let factory: IDBFactory;
let values: Map<string, string>;
const spillKey = (key: string) => `whiteboard.content.v1.${key}`;
function locks() {
  vi.stubGlobal("navigator", { locks: { request: async (_key: string, work: () => unknown) => work() } });
}
function envelope(key: string, payload: unknown, baseChangeSeq: number | null): FallbackBookEnvelope {
  return { v: 2, owner, key, payload, payloadPresent: true, token: crypto.randomUUID(), writerId: bookWriterIdentity(),
    metadata: key === owner.id ? { ...owner, name: "Fallback", locked: true } : null,
    state: seedSyncState(owner.kind, owner.id), baseChangeSeq };
}
async function seed() {
  await mutateLocalBook(owner, {}, ctx => {
    ctx.setContent({ board: { elements: [] }, source: "durable" });
    ctx.setMetadata({ ...owner, name: "Durable", locked: true });
  });
  await refreshBookMetadata();
  return (await getBookSyncState(owner.kind, owner.id))!.changeSeq;
}
beforeEach(async () => {
  await closeDbForTests(); factory = new IDBFactory(); values = new Map();
  vi.stubGlobal("indexedDB", factory); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key) });
  locks(); resetBookCoordinatorForTests(); resetLocalBookStoreForTests();
});
afterEach(async () => { await closeDbForTests(); resetLocalBookStoreForTests(); vi.unstubAllGlobals(); });

describe("durable fallback and guarded book promotion", () => {
  it("round-trips payload, canonical metadata, lifecycle and token without IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await mutateLocalBook(owner, {}, ctx => {
      ctx.setContent({ source: "kept", board: { elements: [{ id: "stroke" }] } });
      ctx.setMetadata({ ...owner, name: "Saved", locked: true }); ctx.markLifecycle("restore", 2);
    });
    const first = listBookFallbacks()[0]!;
    expect(first.token).toMatch(/^[0-9a-f-]{36}$/);
    resetLocalBookStoreForTests(); await hydrateBookMetadata();
    expect(readFallbackContent(owner.id)).toEqual(first.payload);
    expect(getCachedBookMeta(owner.kind, owner.id)).toMatchObject({ name: "Saved", locked: true });
    expect(listBookFallbacks()[0]!.state.lifecycle).toMatchObject({ action: "restore", token: first.state.lifecycle!.token });
    await expect(ensureBookReadyForAtomicSync(owner)).rejects.toThrow();
    expect(listBookFallbacks()).toEqual([first]);
  });

  it("retains the previous readable envelope if its replacement hits quota", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await mutateLocalBook(owner, {}, ctx => ctx.setContent({ source: "saved" }));
    const previous = values.get(spillKey(owner.id));
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    await expect(mutateLocalBook(owner, {}, ctx => ctx.setContent({ source: "unsaved" }))).rejects.toThrow("out of space");
    expect(values.get(spillKey(owner.id))).toBe(previous);
    expect(readFallbackContent(owner.id)).toEqual({ source: "saved" });
  });

  it("saves independent writer branches with neither Web Locks nor IndexedDB", async () => {
    vi.stubGlobal("navigator", {}); vi.stubGlobal("indexedDB", undefined);
    await mutateLocalBook(owner, {}, ctx => ctx.setContent({ source: "window A" }));
    const firstWriter = bookWriterIdentity();
    resetBookCoordinatorForTests(); resetLocalBookStoreForTests();
    await mutateLocalBook(owner, {}, ctx => ctx.setContent({ source: "window B" }));
    expect(bookWriterIdentity()).not.toBe(firstWriter);
    expect(readFallbackContent(owner.id)).toEqual({ source: "window B" });
    expect(listBookFallbacks().map(row => row.payload)).toEqual([{ source: "window A" }, { source: "window B" }]);
    await mutateLocalBook(owner, {}, ctx => ctx.setContent({ source: "window B newer" }));
    expect(listBookFallbacks().map(row => row.payload)).toEqual([{ source: "window A" }, { source: "window B newer" }]);
    resetBookCoordinatorForTests(); resetLocalBookStoreForTests();
    expect(() => readFallbackContent(owner.id)).toThrow("Saved local copies differ");
    vi.stubGlobal("indexedDB", factory); locks();
    await expect(promoteBookFallbacks(owner)).rejects.toThrow("Saved local copies differ");
    expect(listBookFallbacks()).toHaveLength(2);
    expect((await listRecoveryCopies()).map(copy => (copy.content as { payload: unknown }).payload)).toEqual(expect.arrayContaining([{ source: "window A" }, { source: "window B newer" }]));
    expect(await listRecoveryCopies()).toHaveLength(2);
  });

  it("promotes parent and scratch payloads with metadata and tracking in one transaction", async () => {
    const base = await seed();
    const parent = envelope(owner.id, { source: "new", board: { elements: [] }, footnotes: [{ wbId: "scratch" }] }, base);
    const child = envelope("fnwb:book:scratch", { board: { elements: [{ id: "ink" }] }, pageCount: 1 }, base);
    values.set(spillKey(parent.key), JSON.stringify(parent)); values.set(spillKey(child.key), JSON.stringify(child));
    expect(await promoteBookFallbacks(owner)).toBe(true);
    expect(await run(STORE_CONTENT, "readonly", store => store.get(parent.key))).toEqual(parent.payload);
    expect(await run(STORE_CONTENT, "readonly", store => store.get(child.key))).toEqual(child.payload);
    expect(await run(STORE_BOOK_META, "readonly", store => store.get("annotate:book"))).toEqual(parent.metadata);
    expect((await getBookSyncState(owner.kind, owner.id))!.changeSeq).toBeGreaterThan(base);
    expect(listBookFallbacks()).toEqual([]);
  });

  it("a newer durable edit blocks promotion and retains both complete copies", async () => {
    const base = await seed();
    const saved = envelope(owner.id, { source: "fallback", board: {} }, base);
    await mutateLocalBook(owner, {}, ctx => ctx.setContent({ source: "newer durable", board: {} }));
    values.set(spillKey(saved.key), JSON.stringify(saved));
    await expect(promoteBookFallbacks(owner)).rejects.toThrow("Saved local copies differ");
    expect(await run(STORE_CONTENT, "readonly", store => store.get(owner.id))).toEqual({ source: "newer durable", board: {} });
    expect(readFallbackContent(owner.id)).toEqual(saved.payload);
  });

  it("an ordinary save first promotes every same-book parent and child spill together", async () => {
    const base = await seed();
    const parent = envelope(owner.id, { source: "fallback parent", board: {} }, base);
    const child = envelope("fnwb:book:scratch", { board: { elements: [{ id: "saved child" }] } }, base);
    values.set(spillKey(parent.key), JSON.stringify(parent)); values.set(spillKey(child.key), JSON.stringify(child));
    await mutateLocalBook(owner, {}, ctx => ctx.setContent({ ...ctx.content as object, source: "new edit" }));
    expect(await run(STORE_CONTENT, "readonly", store => store.get(owner.id))).toMatchObject({ source: "new edit" });
    expect(await run(STORE_CONTENT, "readonly", store => store.get(child.key))).toEqual(child.payload);
    expect(listBookFallbacks()).toHaveLength(0);
    expect((await getBookSyncState(owner.kind, owner.id))!.changeSeq).toBeGreaterThan(base + 1);
  });

  it("refuses a changed captured token while waiting for the writer lock", async () => {
    const base = await seed(); const first = envelope(owner.id, { source: "first" }, base);
    values.set(spillKey(owner.id), JSON.stringify(first));
    let release!: () => void;
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, work: () => unknown) => {
      await new Promise<void>(resolve => { release = resolve; }); return work();
    } } });
    const promoting = promoteBookFallbacks(owner);
    const newer = { ...first, token: crypto.randomUUID(), payload: { source: "newer" } };
    values.set(spillKey(owner.id), JSON.stringify(newer)); release();
    await expect(promoting).rejects.toThrow("newer fallback edit");
    expect(readFallbackContent(owner.id)).toEqual(newer.payload);
    expect(await run(STORE_CONTENT, "readonly", store => store.get(owner.id))).toMatchObject({ source: "durable" });
  });

  it("keeps a new spill arriving as the promotion transaction commits", async () => {
    const base = await seed(); const first = envelope(owner.id, { source: "first" }, base);
    values.set(spillKey(owner.id), JSON.stringify(first));
    const db = await openDb(); const original = db.transaction.bind(db);
    const newer = { ...first, token: crypto.randomUUID(), payload: { source: "newer" } };
    const intercept = vi.spyOn(db, "transaction").mockImplementation((...args: Parameters<IDBDatabase["transaction"]>) => {
      const tx = original(...args);
      if (args[1] === "readwrite") tx.addEventListener("complete", () => values.set(spillKey(owner.id), JSON.stringify(newer)));
      return tx;
    });
    await promoteBookFallbacks(owner); intercept.mockRestore();
    expect(await run(STORE_CONTENT, "readonly", store => store.get(owner.id))).toEqual(first.payload);
    expect(readFallbackContent(owner.id)).toEqual(newer.payload);
    expect(values.get(spillKey(owner.id))).toBe(JSON.stringify(newer));
  });

  it("a failed promotion writes none of parent, children, metadata or counter", async () => {
    const base = await seed(); const first = envelope(owner.id, { source: "replacement" }, base);
    const child = envelope("fnwb:book:scratch", { board: { elements: [{ id: "saved" }] } }, base);
    values.set(spillKey(first.key), JSON.stringify(first)); values.set(spillKey(child.key), JSON.stringify(child));
    const db = await openDb(); const original = db.transaction.bind(db);
    const beforeState = await getBookSyncState(owner.kind, owner.id);
    const beforeCounter = await run(STORE_SYNC_STATE, "readonly", store => store.get("__seq"));
    const intercept = vi.spyOn(db, "transaction").mockImplementation((...args: Parameters<IDBDatabase["transaction"]>) => {
      const tx = original(...args);
      if (args[1] === "readwrite") {
        const store = tx.objectStore(STORE_CONTENT);
        vi.spyOn(store, "put").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
        const objectStore = tx.objectStore.bind(tx);
        vi.spyOn(tx, "objectStore").mockImplementation(name => name === STORE_CONTENT ? store : objectStore(name));
      }
      return tx;
    });
    await expect(promoteBookFallbacks(owner)).rejects.toThrow("full"); intercept.mockRestore();
    expect(await run(STORE_CONTENT, "readonly", store => store.get(owner.id))).toMatchObject({ source: "durable" });
    expect(await run(STORE_CONTENT, "readonly", store => store.get(child.key))).toBeUndefined();
    expect(await getBookSyncState(owner.kind, owner.id)).toEqual(beforeState);
    expect(await run(STORE_SYNC_STATE, "readonly", store => store.get("__seq"))).toEqual(beforeCounter);
    expect(listBookFallbacks()).toHaveLength(2);
  });

  it("accepts a legacy raw spill without inventing a common base", async () => {
    await openDb();
    values.set("whiteboard.annotate.index.v1", JSON.stringify([{ id: "book", name: "Legacy" }]));
    values.set(spillKey(owner.id), JSON.stringify({ source: "legacy raw", board: {} }));
    expect(readFallbackContent(owner.id)).toEqual({ source: "legacy raw", board: {} });
    await promoteBookFallbacks(owner);
    expect(await run(STORE_CONTENT, "readonly", store => store.get(owner.id))).toEqual({ source: "legacy raw", board: {} });
    expect((await getBookSyncState(owner.kind, owner.id))!.bootstrap).toBe(true);
  });
});
