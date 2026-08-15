import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LcApiError, type LcClient } from "../api/client";
import {
  deletePadEverywhere,
  enqueuePadSync,
  flushPadSyncQueue,
  peekPadSyncQueueForTests,
  pullPads,
  resetPadSyncQueueForTests,
} from "./padSync";

const restoreWhiteboardNotebook = vi.fn(async (_entry?: unknown) => {});
const deletePadSnapshots = vi.fn(async (_kind?: string, _key?: string) => {});
const deleteDocBytes = vi.fn(async (_hash?: string) => {});
const getWhiteboardNotebook = vi.fn(async (_id?: string): Promise<unknown> => null);
const listWhiteboardNotebooks = vi.fn(() => [] as { id: string }[]);
const listAnnotateDocs = vi.fn(() => [] as { id: string }[]);
const getAnnotateDoc = vi.fn(async (_id?: string) => null);
const restoreAnnotateDoc = vi.fn(async (_entry?: unknown) => {});
const getDocBytes = vi.fn(async (_hash?: string) => null);
const putDocBytes = vi.fn(async (_hash?: string, _bytes?: ArrayBuffer) => {});
const getPadSnapshot = vi.fn(async (_kind?: string, _key?: string, _tier?: string) => null);

vi.mock("./whiteboardStore", () => ({
  listWhiteboardNotebooks: () => listWhiteboardNotebooks(),
  getWhiteboardNotebook: (id: string) => getWhiteboardNotebook(id),
  restoreWhiteboardNotebook: (entry: unknown) => restoreWhiteboardNotebook(entry),
  deleteWhiteboardNotebook: vi.fn(async () => {}),
}));

vi.mock("./annotateStore", () => ({
  listAnnotateDocs: () => listAnnotateDocs(),
  getAnnotateDoc: (id: string) => getAnnotateDoc(id),
  restoreAnnotateDoc: (entry: unknown) => restoreAnnotateDoc(entry),
  deleteAnnotateDoc: vi.fn(async () => {}),
}));

vi.mock("./docBytes", () => ({
  getDocBytes: (hash: string) => getDocBytes(hash),
  putDocBytes: (hash: string, bytes: ArrayBuffer) => putDocBytes(hash, bytes),
  deleteDocBytes: (hash: string) => deleteDocBytes(hash),
}));

vi.mock("./padSnapshotStore", () => ({
  PAD_SNAPSHOT_TIERS: [
    { id: "2h", maxAgeMs: 1, label: "2 hours" },
    { id: "24h", maxAgeMs: 1, label: "24 hours" },
    { id: "7d", maxAgeMs: 1, label: "7 days" },
  ],
  getPadSnapshot: (kind: string, key: string, tier: string) => getPadSnapshot(kind, key, tier),
  deletePadSnapshots: (kind: string, key: string) => deletePadSnapshots(kind, key),
}));

function fakeClient(overrides: Partial<LcClient> = {}): LcClient {
  return {
    putWhiteboardPad: vi.fn(async () => ({})),
    putAnnotatePad: vi.fn(async () => ({})),
    putPadSnapshot: vi.fn(async () => {}),
    putDocBytes: vi.fn(async () => {}),
    tombstoneWhiteboardPad: vi.fn(async () => {}),
    tombstoneAnnotatePad: vi.fn(async () => {}),
    listWhiteboardPads: vi.fn(async () => []),
    listAnnotatePads: vi.fn(async () => []),
    listWhiteboardArchive: vi.fn(async () => []),
    listAnnotateArchive: vi.fn(async () => []),
    getPadSnapshots: vi.fn(async () => []),
    getDocBytes: vi.fn(async () => null),
    ...overrides,
  } as unknown as LcClient;
}

beforeEach(() => {
  resetPadSyncQueueForTests();
  restoreWhiteboardNotebook.mockClear();
  deletePadSnapshots.mockClear();
  deleteDocBytes.mockClear();
  getWhiteboardNotebook.mockReset();
  getWhiteboardNotebook.mockResolvedValue(null);
  listWhiteboardNotebooks.mockReturnValue([]);
  listAnnotateDocs.mockReturnValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("padSync queue", () => {
  it("queues while offline and flushes on online", async () => {
    const client = fakeClient({
      putWhiteboardPad: vi.fn(async () => {
        throw new LcApiError("offline", 0);
      }),
    });
    await enqueuePadSync({
      op: "putWhiteboard",
      body: {
        id: "w1",
        title: "One",
        updated_at: 1,
        page_count: 1,
        board: { v: 1, elements: [] },
        agent: [],
      },
    });
    expect(peekPadSyncQueueForTests()).toHaveLength(1);
    await flushPadSyncQueue(client);
    expect(peekPadSyncQueueForTests()).toHaveLength(1);

    const online = fakeClient();
    await flushPadSyncQueue(online);
    expect(online.putWhiteboardPad).toHaveBeenCalledTimes(1);
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
  });
});

describe("padSync pull", () => {
  it("does not delete snapshots or bytes when the server omitted a row", async () => {
    const client = fakeClient({
      listWhiteboardPads: vi.fn(async () => [
        {
          id: "w1",
          title: "One",
          updated_at: 1,
          page_count: 1,
          board: { v: 1, elements: [{ id: "a" }] },
          agent: [],
        },
      ]),
      getPadSnapshots: vi.fn(async () => []),
    });
    await pullPads(client);
    expect(deletePadSnapshots).not.toHaveBeenCalled();
    expect(deleteDocBytes).not.toHaveBeenCalled();
  });

  it("restores corrupt local content from the server fixture", async () => {
    getWhiteboardNotebook.mockResolvedValueOnce({
      id: "w1",
      title: "broken",
      updatedAt: 1,
      pageCount: 1,
      board: { v: 99, elements: null } as never,
      agent: [],
    });
    const server = {
      id: "w1",
      title: "One",
      updated_at: 9,
      page_count: 2,
      board: { v: 1, elements: [{ id: "ok" }] },
      agent: [{ role: "assistant" }],
    };
    const client = fakeClient({
      listWhiteboardPads: vi.fn(async () => [server]),
    });
    await pullPads(client);
    expect(restoreWhiteboardNotebook).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "w1",
        title: "One",
        board: server.board,
      }),
    );
  });
});

describe("deletePadEverywhere", () => {
  it("tombs the server copy and never issues HTTP DELETE", async () => {
    const localDelete = vi.fn(async () => {});
    const client = fakeClient();
    await deletePadEverywhere(client, "whiteboard", "w1", localDelete);
    expect(localDelete).toHaveBeenCalled();
    expect(client.tombstoneWhiteboardPad).toHaveBeenCalledWith("w1");
    expect(client).not.toHaveProperty("deleteWhiteboardPad");
  });
});
