import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InkPageDto, LcClient } from "../api/client";
import { encodeInkOps } from "../canvas/inkCodec";
import { inkPageKey, putInkPageArchive, putInkPages, type InkPageRecord } from "./inkPageStore";
import { syncInkPages } from "./inkSync";
import { walkSyncInk, type WalkSnapshot } from "./hubWalk";

const state = vi.hoisted(() => ({ local: new Map<string, InkPageRecord>() }));
vi.mock("./padHub", () => ({ loadPadHub: () => ({ url: "http://fixture", token: "test" }) }));
vi.mock("./inkPageStore", async (original) => ({
  ...await original<typeof import("./inkPageStore")>(),
  getInkPageRecords: async (docKey: string) => [...state.local.values()].filter((row) => row.docKey === docKey),
  getInkPageRecord: async (docKey: string, pageId: number) => state.local.get(`${docKey}\u001f${pageId}`) ?? null,
}));
vi.mock("./idb", async (original) => ({
  ...await original<typeof import("./idb")>(),
  STORE_INK_PAGES: "ink_pages",
  withStore: async (_name: string, _mode: string, work: (store: unknown) => void) => {
    const rows = state.local;
    const requests: Array<() => void> = [];
    work({
      get: (key: string) => {
        const request = { result: undefined as InkPageRecord | undefined, onsuccess: null as (() => void) | null };
        requests.push(() => { request.result = rows.get(key); request.onsuccess?.(); });
        return request;
      },
      put: (row: InkPageRecord, key: string) => rows.set(key, row),
    });
    for (const request of requests) request();
  },
}));

const pad = { kind: "whiteboard" as const, id: "w", hubAckUpdatedAt: () => 0, buildBody: () => ({} as never) };
const key = inkPageKey("wb:w", 1);
const ink = encodeInkOps([]);
const hub = new Map<number, InkPageDto>();
const client = {
  getInkPages: vi.fn(async () => [...hub.values()]),
  getInkPage: vi.fn(async (_kind: string, _key: string, pageId: number) => hub.get(pageId) ?? null),
  putInkPage: vi.fn(async (page: InkPageDto) => { hub.set(page.page_id, page); }),
} as unknown as LcClient;
const snapshot = (): WalkSnapshot => ({
  annotateRows: [], whiteboardRows: [], edges: [], goneEdges: [],
  inkDigests: [...hub.values()].map(({ gz: _gz, ...digest }) => digest),
});
const sync = () => walkSyncInk(client, pad, snapshot(), 0);
beforeEach(() => {
  state.local = new Map(); hub.clear(); vi.clearAllMocks();
  vi.mocked(client.getInkPages).mockImplementation(async () => [...hub.values()]);
  vi.mocked(client.getInkPage).mockImplementation(async (_kind, _key, pageId) => hub.get(pageId) ?? null);
  vi.mocked(client.putInkPage).mockImplementation(async (page) => {
    hub.set(page.page_id, page);
    return { applied: true, seq: 0 };
  });
});

describe("two-device ink sync", () => {
  it("downloads only the changed page in a large book", async () => {
    await putInkPages("wb:w", Array.from({length:100}, (_,i) => [i+1,ink] as const), {now:100});
    await sync();
    const before = hub.get(73)!;
    hub.set(73,{...before,updated_at:200});
    vi.mocked(client.getInkPage).mockClear();
    expect(await sync()).toEqual({outcome:"ok"});
    expect(client.getInkPage).toHaveBeenCalledTimes(1);
    expect(client.getInkPage).toHaveBeenCalledWith("whiteboard","w",73);
    expect(client.getInkPages).not.toHaveBeenCalled();
    expect(state.local.get(inkPageKey("wb:w",73))?.syncedUpdatedAt).toBe(200);
  });
  it("does not acknowledge a refused write that lost a race on the hub", async () => {
    await putInkPages("wb:w", [[1, ink]], { now: 100 });
    vi.mocked(client.putInkPage).mockImplementationOnce(async (page) => {
      hub.set(1, { ...page, updated_at: 200 });
      return { applied: false, seq: 1 };
    });
    await expect(sync()).rejects.toThrow("refused");
    expect(state.local.get(key)?.syncedUpdatedAt).toBeUndefined();
    expect(state.local.get(key)?.updatedAt).toBe(100);
  });

  it("accepts an exact retry after the original upload response was lost", async () => {
    await putInkPages("wb:w", [[1, ink]], { now: 100 });
    vi.mocked(client.putInkPage).mockImplementationOnce(async (page) => {
      hub.set(1, page);
      return { applied: false, seq: 1 };
    });
    expect(await sync()).toEqual({ outcome: "ok" });
    expect(state.local.get(key)?.syncedUpdatedAt).toBe(100);
  });

  it("rejects corrupt ink before replacing a readable local copy", async () => {
    await putInkPages("wb:w", [[1, ink]], { now: 100 });
    await sync();
    hub.set(1, { ...hub.get(1)!, updated_at: 200, gz: "YQ==" });
    await expect(sync()).rejects.toThrow("could not be read");
    expect(state.local.get(key)).toMatchObject({ updatedAt: 100, syncedUpdatedAt: 100, inkC: ink });
  });

  it("first sync, archive, repeated sync, and subsequent edits converge without self-conflicts", async () => {
    await putInkPages("wb:w", [[1, ink]], { now: 100 });
    expect(await sync()).toEqual({ outcome: "ok" });
    const sent = hub.get(1)!;
    const { b64ToBytes } = await import("../api/nativeHttp");
    await putInkPageArchive("wb:w", 1, b64ToBytes(sent.gz!), 100);
    expect(await sync()).toEqual({ outcome: "ok" });
    expect(client.putInkPage).toHaveBeenCalledTimes(1);
    await putInkPages("wb:w", [[1, ink]], { now: 200 });
    expect(await sync()).toEqual({ outcome: "ok" });
    expect(hub.get(1)?.updated_at).toBe(200);
    state.local = new Map(); // A second device has no ink yet.
    expect(await sync()).toEqual({ outcome: "ok" });
    expect(state.local.get(key)).toMatchObject({ updatedAt: 200, syncedUpdatedAt: 200 });
    await putInkPages("wb:w", [[1, ink]], { now: 250 });
    expect(await sync()).toEqual({ outcome: "ok" });
    expect(hub.get(1)?.updated_at).toBe(250);
  });

  it("keeps both copies of a true same-page conflict until the reader chooses", async () => {
    await putInkPages("wb:w", [[1, ink]], { now: 100 });
    await sync();
    hub.set(1, { ...hub.get(1)!, updated_at: 250 });
    await putInkPages("wb:w", [[1, ink]], { now: 200 });
    expect(await sync()).toMatchObject({ outcome: "conflict", pageId: 1 });
    const result = await syncInkPages(client, snapshot().inkDigests, [{ kind: "whiteboard", key: "w" }], 0);
    expect(result).toHaveLength(1);
    expect(hub.get(1)?.updated_at).toBe(250);
    expect(state.local.get(key)?.updatedAt).toBe(200);
    expect(client.getInkPages).not.toHaveBeenCalled();
  });

  it("does not acknowledge an upload that failed", async () => {
    await putInkPages("wb:w", [[1, ink]], { now: 100 });
    vi.mocked(client.putInkPage).mockRejectedValueOnce(new Error("offline"));
    await expect(sync()).rejects.toThrow("offline");
    expect(state.local.get(key)?.syncedUpdatedAt).toBeUndefined();
    expect(await sync()).toEqual({ outcome: "ok" });
  });

  it("refuses an incomplete download without publishing an empty page", async () => {
    await putInkPages("wb:w", [[1, ink]], { now: 100 });
    await sync();
    state.local = new Map();
    vi.mocked(client.getInkPage).mockResolvedValueOnce(null);
    await expect(sync()).rejects.toThrow("missing");
    expect(state.local.size).toBe(0);
    expect(await sync()).toEqual({ outcome: "ok" });
  });

  it("does not overwrite a stroke arriving while a newer hub page downloads", async () => {
    await putInkPages("wb:w", [[1, ink]], { now: 100 });
    await sync();
    hub.set(1, { ...hub.get(1)!, updated_at: 200 });
    vi.mocked(client.getInkPage).mockImplementationOnce(async () => {
      await putInkPages("wb:w", [[1, ink]], { now: 300 });
      return hub.get(1)!;
    });
    await expect(sync()).rejects.toThrow("changed during download");
    expect(state.local.get(key)).toMatchObject({ updatedAt: 300, syncedUpdatedAt: 100, dirty: true });
  });
});
