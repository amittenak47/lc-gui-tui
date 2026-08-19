import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LcApiError, type LcClient } from "../api/client";
import {
  applyPadSyncPing,
  deletePadEverywhere,
  enqueuePadSync,
  flushPadSyncQueue,
  peekPadSyncQueueForTests,
  pullPads,
  PAD_TRASH_OP_QUEUE_CAP,
  pushPadSnapshot,
  pushProblemPad,
  pushWhiteboardPad,
  resetPadSyncQueueForTests,
  restoreTrashedPad,
  TrashQueueFullError,
} from "./padSync";

const restoreWhiteboardNotebook = vi.fn(async (_entry?: unknown) => {});
const restoreWhiteboardFromTrash = vi.fn(
  async (_id?: string): Promise<unknown> => ({ id: "w1", syncSeq: 2 }),
);
const deletePadSnapshots = vi.fn(async (_kind?: string, _key?: string) => {});
const deleteDocBytes = vi.fn(async (_hash?: string) => {});
const getWhiteboardNotebook = vi.fn(async (_id?: string): Promise<unknown> => null);
const listWhiteboardNotebooks = vi.fn(() => [] as { id: string }[]);
const listWhiteboardTrash = vi.fn(() => [] as { id: string; lastTouch?: number; deletedAt?: number }[]);
const listAnnotateDocs = vi.fn(() => [] as { id: string }[]);
const listAnnotateTrash = vi.fn(() => [] as { id: string; lastTouch?: number; deletedAt?: number }[]);
const getAnnotateDoc = vi.fn(async (_id?: string): Promise<unknown> => null);
const restoreAnnotateDoc = vi.fn(async (_entry?: unknown) => {});
const restoreAnnotateFromTrash = vi.fn(async (_id?: string): Promise<unknown> => null);
const deleteWhiteboardNotebook = vi.fn(async (_id?: string) => {});
const deleteAnnotateDoc = vi.fn(async (_id?: string) => {});
const trashWhiteboardNotebook = vi.fn(async (_id?: string) => 1);
const trashAnnotateDoc = vi.fn(async (_id?: string) => 1);
const markWhiteboardDeleteAcked = vi.fn();
const markAnnotateDeleteAcked = vi.fn();
const getDocBytes = vi.fn(async (_hash?: string) => null);
const putDocBytes = vi.fn(async (_hash?: string, _bytes?: ArrayBuffer) => {});
const getPadSnapshot = vi.fn(
  async (_kind?: string, _key?: string, _tier?: string): Promise<unknown> => null,
);

const emptyBoard = {
  v: 1 as const,
  elements: [] as unknown[],
  appState: { scrollX: 0, scrollY: 0, zoom: 1 },
};

vi.mock("./whiteboardStore", () => ({
  listWhiteboardNotebooks: () => listWhiteboardNotebooks(),
  listWhiteboardTrash: () => listWhiteboardTrash(),
  getWhiteboardNotebook: (id: string) => getWhiteboardNotebook(id),
  restoreWhiteboardNotebook: (entry: unknown) => restoreWhiteboardNotebook(entry),
  restoreWhiteboardFromTrash: (id: string) => restoreWhiteboardFromTrash(id),
  deleteWhiteboardNotebook: (id: string) => deleteWhiteboardNotebook(id),
  trashWhiteboardNotebook: (id: string) => trashWhiteboardNotebook(id),
  markWhiteboardDeleteAcked: (id: string, acked: boolean) => markWhiteboardDeleteAcked(id, acked),
  markWhiteboardHubAck: () => {},
}));

vi.mock("./annotateStore", () => ({
  listAnnotateDocs: () => listAnnotateDocs(),
  listAnnotateTrash: () => listAnnotateTrash(),
  getAnnotateDoc: (id: string) => getAnnotateDoc(id),
  restoreAnnotateDoc: (entry: unknown) => restoreAnnotateDoc(entry),
  restoreAnnotateFromTrash: (id: string) => restoreAnnotateFromTrash(id),
  deleteAnnotateDoc: (id: string) => deleteAnnotateDoc(id),
  trashAnnotateDoc: (id: string) => trashAnnotateDoc(id),
  markAnnotateDeleteAcked: (id: string, acked: boolean) => markAnnotateDeleteAcked(id, acked),
  markAnnotateHubAck: () => {},
}));

const deleteProblemBoard = vi.fn(async (_id?: string) => {});
const putProblemBoard = vi.fn(async (_row?: unknown) => {});
const getProblemBoard = vi.fn(async (_id?: string): Promise<unknown> => null);

vi.mock("./problemBoardStore", () => ({
  deleteProblemBoard: (id: string) => deleteProblemBoard(id),
  getProblemBoard: (id: string) => getProblemBoard(id),
  putProblemBoard: (row: unknown) => putProblemBoard(row),
  markProblemHubAck: () => {},
  problemPadId: (dataset: string, taskId: string) => `${dataset}/${taskId}`,
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
  listPadSnapshots: async () => [],
  deletePadSnapshots: (kind: string, key: string) => deletePadSnapshots(kind, key),
}));

function fakeClient(overrides: Partial<LcClient> = {}): LcClient {
  return {
    putWhiteboardPad: vi.fn(async () => ({})),
    putAnnotatePad: vi.fn(async () => ({})),
    putPadSnapshot: vi.fn(async () => {}),
    putDocBytes: vi.fn(async () => {}),
    tombstoneWhiteboardPad: vi.fn(async () => ({ applied: true, seq: 1 })),
    tombstoneAnnotatePad: vi.fn(async () => ({ applied: true, seq: 1 })),
    tombstoneProblemPad: vi.fn(async () => ({ applied: true, seq: 1 })),
    putProblemPad: vi.fn(async () => ({})),
    listWhiteboardPads: vi.fn(async () => []),
    listAnnotatePads: vi.fn(async () => []),
    listWhiteboardArchive: vi.fn(async () => []),
    listAnnotateArchive: vi.fn(async () => []),
    getPadSnapshots: vi.fn(async () => []),
    getDocBytes: vi.fn(async () => null),
    pingPadSync: vi.fn(async () => ({
      now: 1,
      whiteboard: [],
      annotate: [],
      snapshots: [],
      gone: [],
    })),
    ...overrides,
  } as unknown as LcClient;
}

beforeEach(() => {
  resetPadSyncQueueForTests();
  restoreWhiteboardNotebook.mockClear();
  restoreAnnotateDoc.mockClear();
  deleteWhiteboardNotebook.mockClear();
  deleteAnnotateDoc.mockClear();
  deletePadSnapshots.mockClear();
  deleteDocBytes.mockClear();
  getWhiteboardNotebook.mockReset();
  getWhiteboardNotebook.mockResolvedValue(null);
  getPadSnapshot.mockReset();
  getPadSnapshot.mockResolvedValue(null);
  restoreWhiteboardFromTrash.mockReset();
  restoreWhiteboardFromTrash.mockResolvedValue({ id: "w1", syncSeq: 2 });
  listWhiteboardNotebooks.mockReturnValue([]);
  listWhiteboardTrash.mockReturnValue([]);
  listAnnotateDocs.mockReturnValue([]);
  listAnnotateTrash.mockReturnValue([]);
  trashWhiteboardNotebook.mockResolvedValue(1);
  markWhiteboardDeleteAcked.mockClear();
  markAnnotateDeleteAcked.mockClear();
  getAnnotateDoc.mockReset();
  getAnnotateDoc.mockResolvedValue(null);
  putProblemBoard.mockClear();
  deleteProblemBoard.mockClear();
  getProblemBoard.mockReset();
  getProblemBoard.mockResolvedValue(null);
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
  it("trashes locally and ACKs hub delete with seq", async () => {
    const client = fakeClient();
    await deletePadEverywhere(client, "whiteboard", "w1");
    expect(trashWhiteboardNotebook).toHaveBeenCalledWith("w1");
    expect(client.tombstoneWhiteboardPad).toHaveBeenCalledWith("w1", 1);
    expect(markWhiteboardDeleteAcked).toHaveBeenCalledWith("w1", true);
  });
});

describe("padSync ping", () => {
  it("writes a newer whiteboard and skips an older annotate", async () => {
    getWhiteboardNotebook.mockResolvedValue({
      id: "w1",
      updatedAt: 10,
      board: { v: 1, elements: [] },
    });
    getAnnotateDoc.mockResolvedValue({
      id: "a1",
      updatedAt: 90,
      board: { v: 1, elements: [] },
    });
    const client = fakeClient({
      pingPadSync: vi.fn(async () => ({
        now: 100,
        whiteboard: [
          {
            id: "w1",
            title: "N",
            updated_at: 40,
            page_count: 1,
            board: { v: 1, elements: [{ id: "x" }] },
            agent: [],
          },
        ],
        annotate: [
          {
            id: "a1",
            name: "n.md",
            hash: "h",
            doc_type: "markdown",
            updated_at: 40,
            source: "#",
            footnotes: [],
            board: { v: 1, elements: [] },
            agent: [],
          },
        ],
        snapshots: [],
        gone: [],
      })),
    });
    await applyPadSyncPing(client);
    expect(restoreWhiteboardNotebook).toHaveBeenCalledTimes(1);
    expect(restoreAnnotateDoc).not.toHaveBeenCalled();
  });

  it("does not undelete local trash from a live hub row", async () => {
    listWhiteboardTrash.mockReturnValue([{ id: "w1", deletedAt: 1 }]);
    getWhiteboardNotebook.mockResolvedValue({
      id: "w1",
      updatedAt: 10,
      deletedAt: 1,
      board: { v: 1, elements: [] },
    });
    const client = fakeClient({
      pingPadSync: vi.fn(async () => ({
        now: 100,
        whiteboard: [
          {
            id: "w1",
            title: "N",
            updated_at: 40,
            page_count: 1,
            board: { v: 1, elements: [{ id: "x" }] },
            agent: [],
          },
        ],
        annotate: [],
        snapshots: [],
        gone: [],
      })),
    });
    await applyPadSyncPing(client);
    expect(restoreWhiteboardNotebook).not.toHaveBeenCalled();
  });

  it("applies gone-id to a peer live copy and ACKs local trash", async () => {
    listWhiteboardTrash.mockReturnValue([{ id: "trashed", deletedAt: 1 }]);
    listAnnotateDocs.mockReturnValue([{ id: "peer" }]);
    const client = fakeClient({
      pingPadSync: vi.fn(async () => ({
        now: 100,
        whiteboard: [],
        annotate: [],
        snapshots: [],
        gone: [
          { kind: "whiteboard", id: "trashed", seq: 2, gone_at: 50 },
          { kind: "annotate", id: "peer", seq: 1, gone_at: 50 },
        ],
      })),
    });
    await applyPadSyncPing(client);
    expect(markWhiteboardDeleteAcked).toHaveBeenCalledWith("trashed", true);
    expect(deleteAnnotateDoc).toHaveBeenCalledWith("peer");
  });
});

describe("live PUT coalesce and 24h compact", () => {
  it("keeps only the latest live PUT per id", async () => {
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
    await enqueuePadSync({
      op: "putWhiteboard",
      body: {
        id: "w1",
        title: "One",
        updated_at: 3,
        page_count: 1,
        board: { v: 1, elements: [] },
        agent: [],
      },
    });
    const queued = peekPadSyncQueueForTests();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ op: "putWhiteboard", body: { updated_at: 3 } });
  });

  it("drops queued live PUTs at or before a 24h ACK", async () => {
    const client = fakeClient();
    await enqueuePadSync({
      op: "putWhiteboard",
      body: {
        id: "w1",
        title: "One",
        updated_at: 2,
        page_count: 1,
        board: { v: 1, elements: [] },
        agent: [],
      },
    });
    await pushPadSnapshot(client, {
      kind: "whiteboard",
      key: "w1",
      tier: "24h",
      writtenAt: 2,
      name: "One",
      board: emptyBoard,
    });
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
  });

  it("keeps a live PUT newer than the 24h stamp", async () => {
    const client = fakeClient();
    await enqueuePadSync({
      op: "putWhiteboard",
      body: {
        id: "w1",
        title: "One",
        updated_at: 3,
        page_count: 1,
        board: { v: 1, elements: [] },
        agent: [],
      },
    });
    await pushPadSnapshot(client, {
      kind: "whiteboard",
      key: "w1",
      tier: "24h",
      writtenAt: 2,
      name: "One",
      board: emptyBoard,
    });
    expect(peekPadSyncQueueForTests()).toHaveLength(1);
  });
});

describe("delete/restore queue", () => {
  it("drops a stale delete ACK and does not retry", async () => {
    const client = fakeClient({
      tombstoneWhiteboardPad: vi.fn(async () => ({ applied: false, seq: 6 })),
    });
    await enqueuePadSync({ op: "deletePad", kind: "whiteboard", padId: "w1", seq: 5 });
    await flushPadSyncQueue(client);
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
    expect(markWhiteboardDeleteAcked).not.toHaveBeenCalled();
  });

  it("evicts LRU other trash when a ninth delete/restore job would exceed the cap", async () => {
    const client = fakeClient({
      tombstoneWhiteboardPad: vi.fn(async () => {
        throw new LcApiError("offline", 0);
      }),
    });
    listWhiteboardTrash.mockReturnValue([]);
    for (let i = 1; i <= PAD_TRASH_OP_QUEUE_CAP; i += 1) {
      await deletePadEverywhere(client, "whiteboard", `w${i}`);
    }
    expect(peekPadSyncQueueForTests().filter((job) => job.op === "deletePad")).toHaveLength(
      PAD_TRASH_OP_QUEUE_CAP,
    );
    listWhiteboardTrash.mockReturnValue(
      Array.from({ length: PAD_TRASH_OP_QUEUE_CAP }, (_, i) => ({
        id: `w${i + 1}`,
        lastTouch: i + 1,
        deletedAt: 1,
      })),
    );
    (client.tombstoneWhiteboardPad as ReturnType<typeof vi.fn>).mockClear();
    await deletePadEverywhere(client, "whiteboard", "w9");
    expect(deleteWhiteboardNotebook).toHaveBeenCalledWith("w1");
    expect(client.tombstoneWhiteboardPad).toHaveBeenCalledWith("w9", 1);
    expect(client.tombstoneWhiteboardPad).not.toHaveBeenCalledWith("w1", expect.anything());
    expect(peekPadSyncQueueForTests().some((job) => "padId" in job && job.padId === "w1")).toBe(
      false,
    );
  });

  it("refuses a new delete when the queue is full and there is no other trash", async () => {
    const client = fakeClient({
      tombstoneWhiteboardPad: vi.fn(async () => {
        throw new LcApiError("offline", 0);
      }),
    });
    listWhiteboardTrash.mockReturnValue([]);
    for (let i = 1; i <= PAD_TRASH_OP_QUEUE_CAP; i += 1) {
      await deletePadEverywhere(client, "whiteboard", `w${i}`);
    }
    trashWhiteboardNotebook.mockClear();
    await expect(deletePadEverywhere(client, "whiteboard", "w9")).rejects.toBeInstanceOf(
      TrashQueueFullError,
    );
    expect(trashWhiteboardNotebook).not.toHaveBeenCalled();
  });

  it("uploads live plus 2h/24h/7d on restore", async () => {
    const client = fakeClient();
    getWhiteboardNotebook.mockResolvedValue({
      id: "w1",
      title: "One",
      updatedAt: 1,
      pageCount: 1,
      syncSeq: 6,
      board: { v: 1, elements: [] },
      agent: [],
    });
    restoreWhiteboardFromTrash.mockResolvedValue({
      id: "w1",
      title: "One",
      updatedAt: 1,
      pageCount: 1,
      syncSeq: 6,
      board: { v: 1, elements: [] },
      agent: [],
    });
    getPadSnapshot.mockImplementation(async (_kind, _key, tier) => ({
      kind: "whiteboard",
      key: "w1",
      tier,
      writtenAt: 1,
      name: "One",
      board: { v: 1, elements: [] },
    }));
    await restoreTrashedPad(client, "whiteboard", "w1");
    expect(client.putWhiteboardPad).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ sync_seq: 6 }),
    );
    const tiers = (client.putPadSnapshot as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].tier,
    );
    expect(tiers.sort()).toEqual(["24h", "2h", "7d"]);
  });
});

describe("live PUT CAS and gone", () => {
  const notebook = {
    id: "w1",
    title: "One",
    updatedAt: 999,
    pageCount: 1,
    hubAckUpdatedAt: 1,
    syncSeq: 0,
    board: emptyBoard,
    agent: [],
  };

  it("applies a 409 body and does not queue", async () => {
    const hub = {
      id: "w1",
      title: "Hub",
      updated_at: 40,
      page_count: 1,
      board: { v: 1, elements: [{ id: "hub" }] },
      agent: [],
    };
    const client = fakeClient({
      putWhiteboardPad: vi.fn(async () => {
        throw new LcApiError("conflict", 409, JSON.stringify(hub), hub);
      }),
    });
    await pushWhiteboardPad(client, notebook);
    expect(restoreWhiteboardNotebook).toHaveBeenCalledWith(
      expect.objectContaining({ id: "w1", updatedAt: 40, hubAckUpdatedAt: 40 }),
    );
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
  });

  it("does not resurrect after 410 gone", async () => {
    const client = fakeClient({
      putWhiteboardPad: vi.fn(async () => {
        throw new LcApiError("gone", 410, JSON.stringify({ gone: true, seq: 5 }), {
          gone: true,
          seq: 5,
        });
      }),
    });
    await pushWhiteboardPad(client, notebook);
    expect(restoreWhiteboardNotebook).not.toHaveBeenCalled();
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
  });

  it("applies a problem 409 body and does not queue", async () => {
    const hub = {
      id: "leetcode/two-sum",
      dataset: "leetcode",
      task_id: "two-sum",
      updated_at: 40,
      board: { v: 1, elements: [{ id: "hub" }] },
      agent: [],
    };
    const client = fakeClient({
      putProblemPad: vi.fn(async () => {
        throw new LcApiError("conflict", 409, JSON.stringify(hub), hub);
      }),
    });
    await pushProblemPad(client, {
      id: "leetcode/two-sum",
      dataset: "leetcode",
      taskId: "two-sum",
      updatedAt: 999,
      hubAckUpdatedAt: 1,
      board: emptyBoard,
      agent: [],
    });
    expect(putProblemBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "leetcode/two-sum",
        updatedAt: 40,
        hubAckUpdatedAt: 40,
      }),
    );
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
  });

  it("peer ping applies a problem row the other device saved", async () => {
    getProblemBoard.mockResolvedValue(null);
    const client = fakeClient({
      pingPadSync: vi.fn(async () => ({
        now: 100,
        whiteboard: [],
        annotate: [],
        problem: [
          {
            id: "leetcode/two-sum",
            dataset: "leetcode",
            task_id: "two-sum",
            updated_at: 40,
            board: { v: 1, elements: [{ id: "peer" }] },
            agent: [],
          },
        ],
        snapshots: [],
        gone: [],
      })),
    });
    await applyPadSyncPing(client);
    expect(putProblemBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "leetcode/two-sum",
        updatedAt: 40,
        hubAckUpdatedAt: 40,
      }),
    );
  });

  it("gone problem ping deletes local live ink so it cannot restore", async () => {
    const client = fakeClient({
      pingPadSync: vi.fn(async () => ({
        now: 100,
        whiteboard: [],
        annotate: [],
        problem: [],
        snapshots: [],
        gone: [{ kind: "problem", id: "leetcode/two-sum", seq: 5, gone_at: 90 }],
      })),
    });
    await applyPadSyncPing(client);
    expect(deleteProblemBoard).toHaveBeenCalledWith("leetcode/two-sum");
  });

  it("drops a queued live PUT when ping applies a newer hub row", async () => {
    await enqueuePadSync({
      op: "putWhiteboard",
      body: {
        id: "w1",
        title: "One",
        updated_at: 999,
        page_count: 1,
        board: { v: 1, elements: [] },
        agent: [],
      },
    });
    getWhiteboardNotebook.mockResolvedValue({
      id: "w1",
      updatedAt: 10,
      board: { v: 1, elements: [] },
    });
    const client = fakeClient({
      pingPadSync: vi.fn(async () => ({
        now: 100,
        whiteboard: [
          {
            id: "w1",
            title: "N",
            updated_at: 40,
            page_count: 1,
            board: { v: 1, elements: [{ id: "x" }] },
            agent: [],
          },
        ],
        annotate: [],
        snapshots: [],
        gone: [],
      })),
    });
    await applyPadSyncPing(client);
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
  });
});
