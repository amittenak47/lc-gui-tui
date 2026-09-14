import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeInkOps } from "../canvas/inkCodec";
import { inkPageKey, markInkPageSynced, putInkPageArchive, putInkPages, type InkPageRecord } from "./inkPageStore";

const state = vi.hoisted(() => ({ rows: new Map<string, InkPageRecord>(), transactions: 0 }));
vi.mock("./idb", () => ({
  STORE_INK_PAGES: "ink_pages",
  run: vi.fn(() => { throw new Error("Archive must use one read/write transaction"); }),
  withStore: async (_name: string, mode: string, work: (store: unknown) => void) => {
    expect(mode).toBe("readwrite");
    state.transactions++;
    const requests: Array<() => void> = [];
    work({
      get: (key: string) => {
        const request = { result: undefined as InkPageRecord | undefined, onsuccess: null as (() => void) | null };
        requests.push(() => { request.result = state.rows.get(key); request.onsuccess?.(); });
        return request;
      },
      put: (row: InkPageRecord, key: string) => state.rows.set(key, row),
    });
    for (const request of requests) request();
  },
}));

beforeEach(() => { state.rows.clear(); state.transactions = 0; });
const encoded = encodeInkOps([]);
const key = inkPageKey("wb:test", 1);

describe("ink archive and sync revisions", () => {
  it("archives without changing the authored revision or losing its hub ack", async () => {
    await putInkPages("wb:test", [[1, encoded]], { now: 100 });
    await markInkPageSynced("wb:test", 1, 100);
    state.transactions = 0;
    expect(await putInkPageArchive("wb:test", 1, new Uint8Array([7]), 100)).toBe(true);
    expect(state.transactions).toBe(1);
    expect(state.rows.get(key)).toMatchObject({ updatedAt: 100, syncedUpdatedAt: 100, dirty: false });
    expect(state.rows.get(key)?.inkC).toBeUndefined();
  });

  it("preserves a newer stroke while an older page is being compressed", async () => {
    await putInkPages("wb:test", [[1, encoded]], { now: 100 });
    await putInkPages("wb:test", [[1, encoded]], { now: 200 });
    expect(await putInkPageArchive("wb:test", 1, new Uint8Array([7]), 100)).toBe(false);
    expect(state.rows.get(key)).toMatchObject({ updatedAt: 200, dirty: true, inkC: encoded });
  });

  it("keeps a stroke arriving during upload dirty and advances only the sent revision", async () => {
    await putInkPages("wb:test", [[1, encoded]], { now: 100 });
    await markInkPageSynced("wb:test", 1, 100);
    await putInkPages("wb:test", [[1, encoded]], { now: 200 });
    await putInkPages("wb:test", [[1, encoded]], { now: 300 });
    await markInkPageSynced("wb:test", 1, 200);
    expect(state.rows.get(key)).toMatchObject({ updatedAt: 300, syncedUpdatedAt: 200, dirty: true });
    await markInkPageSynced("wb:test", 1, 100);
    expect(state.rows.get(key)?.syncedUpdatedAt).toBe(200);
  });

  it("distinguishes two writes in the same clock millisecond", async () => {
    await putInkPages("wb:test", [[1, encoded]], { now: 100 });
    await putInkPages("wb:test", [[1, encoded]], { now: 100 });
    expect(state.rows.get(key)?.updatedAt).toBe(101);
    expect(await putInkPageArchive("wb:test", 1, new Uint8Array([7]), 100)).toBe(false);
  });
});
