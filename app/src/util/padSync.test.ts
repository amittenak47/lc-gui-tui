import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LcApiError, type LcClient } from "../api/client";
import {
  annotatePadBody,
  applyHubAnnotate,
  applyHubWhiteboard,
  applyPadSyncPing,
  deletePadEverywhere,
  discoverHubPads,
  enqueuePadSync,
  flushPadSyncQueue,
  peekPadSyncQueueForTests,
  pullPads,
  PAD_TRASH_OP_QUEUE_CAP,
  PAD_SYNC_IDLE_KICK_MS_ANDROID,
  PAD_SYNC_IDLE_KICK_MS_DESKTOP,
  padSyncIdleKickMs,
  pushAnnotatePad,
  pushDocBytes,
  pushPadSnapshot,
  pushProblemPad,
  pushWhiteboardPad,
  whiteboardPadBody,
  resetPadSyncQueueForTests,
  restoreTrashedPad,
  scheduleIdlePadSyncPing,
  setPadSyncBodyCapForTests,
  TrashQueueFullError,
} from "./padSync";
import { noteCameraBusy, resetCameraBusyForTests } from "./cameraBusy";
import { setHostLoopback } from "./padHub";
import * as inkSync from "./inkSync";
import { persistableAgentMessages, restoreAgentMessages } from "../modes/agentTranscript";
import type { AgentChatMessage } from "../modes/AgentSidePanel";
import type { ArtifactCatalog } from "./padArtifacts";
import { parseVizProgram } from "../viz/schema";
import { visibleDrawings } from "../viz/drawingState";

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

it.each(["annotate", "whiteboard"])("keeps local tombstones when applying a stale %s transcript", async kind => {
  const local = { agent: [{ id: "q", role: "user", content: "gone", deletedAt: 40, future: { keep: true } }] };
  const getter = kind === "annotate" ? getAnnotateDoc : getWhiteboardNotebook;
  const restore = kind === "annotate" ? restoreAnnotateDoc : restoreWhiteboardNotebook;
  getter.mockResolvedValue(local);
  const apply = kind === "annotate" ? applyHubAnnotate : applyHubWhiteboard;
  await apply({ id: "sync-chat", board: emptyBoard, agent: [
    { id: "q", role: "user", content: "gone" },
    { id: "reply", role: "assistant", content: "offline", replyTo: { id: "q" } },
  ] }, { emitReload: false });
  const saved = restore.mock.calls.at(-1)![0] as { agent: unknown[] };
  expect(saved.agent).toEqual([
    expect.objectContaining({ id: "q", deletedAt: 40, future: { keep: true } }),
    expect.objectContaining({ id: "reply", deletedAt: 40 }),
  ]);
});

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
  annotateDocLabel: (doc: { label?: string; name?: string }) => doc.label?.trim() || doc.name || "",
}));

const deleteProblemBoard = vi.fn(async (_id?: string) => {});
const putProblemBoard = vi.fn(async (_row?: unknown) => {});
const getProblemBoard = vi.fn(async (_id?: string): Promise<unknown> => null);

vi.mock("./problemBoardStore", () => ({
  acceptProblemHubAgent: async () => {},
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

const hubAutosyncState = vi.hoisted(() => ({ on: true }));
vi.mock("./hubAutoSyncPref", () => ({
  loadHubAutosync: () => hubAutosyncState.on,
}));

const footnoteBoardMocks = vi.hoisted(() => ({
  applyFootnoteBoards: vi.fn(async (_docId?: string, _boards?: unknown) => {}),
  collectFootnoteBoards: vi.fn(async (_docId?: string, _footnotes?: unknown, _opts?: unknown) => ({})),
}));
vi.mock("./footnoteWhiteboardStore", () => ({
  applyFootnoteBoards: (docId: string, boards: unknown) =>
    footnoteBoardMocks.applyFootnoteBoards(docId, boards),
  collectFootnoteBoards: (docId: string, footnotes: unknown, opts: unknown) =>
    footnoteBoardMocks.collectFootnoteBoards(docId, footnotes, opts),
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
  resetCameraBusyForTests();
  hubAutosyncState.on = true;
  footnoteBoardMocks.applyFootnoteBoards.mockClear();
  footnoteBoardMocks.collectFootnoteBoards.mockClear();
  footnoteBoardMocks.collectFootnoteBoards.mockResolvedValue({});
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
  vi.restoreAllMocks();
  setHostLoopback(null);
  vi.unstubAllGlobals();
  resetCameraBusyForTests();
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
  it.each([true, false])("round-trips chat drawings with expanded=%s through notebook and document sync", async (expanded) => {
    setHostLoopback({ url: "http://fixture", token: "test" });
    const program = parseVizProgram({
      id: "walk", viz: "array", title: "Array walk",
      frames: [
        { label: "Start", cells: [1, 2, 3], pointers: { i: 0 } },
        { label: "Next", cells: [1, 2, 3], pointers: { i: 1 } },
      ],
    })!;
    expect(program).toBeTruthy();
    const messages: AgentChatMessage[] = [
      { id: "question", role: "user", content: "Explain the walk", at: 1 },
      {
        id: "answer", role: "assistant", at: 2,
        content: "**Index** $i$\n\n$$i + 1$$",
        reasoning: "Compare the two positions.",
        processEvents: [{ kind: "stage", label: "reason", detail: "Check the index.", ts: 2 }],
        replyTo: { id: "question", role: "user", excerpt: "Explain the walk" },
        drawing: { program, expanded, redacted: false, frameIndex: 1 },
      },
      { id: "pending", role: "assistant", content: "", at: 3, pending: true },
    ];
    const agent = persistableAgentMessages(messages);
    const sender = fakeClient();
    await pushWhiteboardPad(sender, {
      id: "w1", title: "Notebook", updatedAt: 100, pageCount: 1, board: emptyBoard, agent,
    });
    await pushAnnotatePad(sender, {
      id: "a1", name: "note.md", hash: "hash", docType: "markdown",
      updatedAt: 100, source: "# Note", board: emptyBoard, agent, footnotes: [],
    });
    // Serialize the actual upload bodies before a fresh device discovers them.
    const whiteboard = JSON.parse(JSON.stringify(vi.mocked(sender.putWhiteboardPad).mock.calls[0]![1]));
    const document = JSON.parse(JSON.stringify(vi.mocked(sender.putAnnotatePad).mock.calls[0]![1]));
    const receiver = fakeClient({
      listWhiteboardPads: vi.fn(async () => [whiteboard]),
      listAnnotatePads: vi.fn(async () => [document]),
      getInkPages: vi.fn(async () => []),
    });
    expect(await discoverHubPads(receiver)).toBe(2);
    for (const restore of [restoreWhiteboardNotebook, restoreAnnotateDoc]) {
      const saved = restore.mock.calls[0]![0] as { agent: unknown[] };
      const reopened = restoreAgentMessages(saved.agent);
      expect(reopened).toEqual(messages.slice(0, 2).map(message => ({ ...message, sessionId: "session-question" })));
      expect(visibleDrawings(reopened)).toHaveLength(expanded ? 1 : 0);
    }
  });

  it("discovers missing pads with autosync off and records the received revision", async () => {
    setHostLoopback({ url: "http://fixture", token: "test" });
    hubAutosyncState.on = false;
    const row = { id: "w1", title: "Tablet notebook", updated_at: 100, sync_seq: 2,
      page_count: 1, board: emptyBoard, agent: [{ id: "chat-1" }] };
    const client = fakeClient({
      listWhiteboardPads: vi.fn(async () => [row]),
      listAnnotatePads: vi.fn(async () => []),
      getInkPages: vi.fn(async () => []),
    });
    expect(await discoverHubPads(client)).toBe(1);
    expect(restoreWhiteboardNotebook).toHaveBeenCalledWith(expect.objectContaining({
      id: "w1", hubAckUpdatedAt: 100, syncSeq: 2, agent: row.agent,
    }));
    expect(hubAutosyncState.on).toBe(false);
  });

  it("never overwrites a local notebook during library discovery", async () => {
    setHostLoopback({ url: "http://fixture", token: "test" });
    getWhiteboardNotebook.mockResolvedValue({ id: "w1", updatedAt: 1, board: emptyBoard });
    const client = fakeClient({
      listWhiteboardPads: vi.fn(async () => [{ id: "w1", title: "Hub", updated_at: 100,
        page_count: 1, board: emptyBoard, agent: [] }]),
      listAnnotatePads: vi.fn(async () => []),
      getInkPages: vi.fn(async () => []),
    });
    expect(await discoverHubPads(client)).toBe(0);
    expect(restoreWhiteboardNotebook).not.toHaveBeenCalled();
    expect(client.getInkPages).not.toHaveBeenCalled();
  });

  it("does not expose a new notebook when its ink download is incomplete", async () => {
    setHostLoopback({ url: "http://fixture", token: "test" });
    const client = fakeClient({
      listWhiteboardPads: vi.fn(async () => [{ id: "w1", title: "Hub", updated_at: 100,
        page_count: 1, board: { ...emptyBoard, inkPages: { v: 1, pageIds: [1] } }, agent: [] }]),
      listAnnotatePads: vi.fn(async () => []),
      getInkPages: vi.fn(async () => []),
    });
    await expect(discoverHubPads(client)).rejects.toThrow("missing");
    expect(restoreWhiteboardNotebook).not.toHaveBeenCalled();
  });

  it("discovers complete pads after an incomplete upload and reports what was skipped", async () => {
    setHostLoopback({ url: "http://fixture", token: "test" });
    hubAutosyncState.on = false;
    const client = fakeClient({
      listWhiteboardPads: vi.fn(async () => [
        { id: "broken", title: "Incomplete notebook", updated_at: 100, page_count: 1,
          board: { ...emptyBoard, inkPages: { v: 1, pageIds: [0] } }, agent: [] },
        { id: "complete", title: "Complete notebook", updated_at: 100, page_count: 1,
          board: emptyBoard, agent: [{ id: "kept-chat" }] },
      ]),
      listAnnotatePads: vi.fn(async () => [{ id: "document", name: "Complete.md", hash: "md-complete",
        doc_type: "markdown", source: "# Complete", updated_at: 100, board: emptyBoard, agent: [], footnotes: [] }]),
      getInkPages: vi.fn(async () => []),
    });
    await expect(discoverHubPads(client)).rejects.toThrow(/Added 2 pads.*Incomplete notebook.*missing/);
    expect(restoreWhiteboardNotebook).toHaveBeenCalledTimes(1);
    expect(restoreWhiteboardNotebook).toHaveBeenCalledWith(expect.objectContaining({ id: "complete", agent: [{ id: "kept-chat" }] }));
    expect(restoreAnnotateDoc).toHaveBeenCalledWith(expect.objectContaining({ id: "document" }));
    expect(hubAutosyncState.on).toBe(false);
  });

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
    const corrupt = {
      id: "w1",
      title: "broken",
      updatedAt: 1,
      pageCount: 1,
      board: { v: 99, elements: null } as never,
      agent: [],
    };
    // The download guard rereads the row before applying the hub copy.
    getWhiteboardNotebook.mockResolvedValueOnce(corrupt).mockResolvedValueOnce(corrupt);
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

describe("padSync download deletion guard", () => {
  it("does not resurrect a corrupt row removed during the download window", async () => {
    getWhiteboardNotebook.mockResolvedValueOnce({
      id: "w1", title: "broken", updatedAt: 1, pageCount: 1,
      board: { v: 99, elements: null } as never, agent: [],
    }).mockResolvedValueOnce(null);
    await pullPads(fakeClient({ listWhiteboardPads: vi.fn(async () => [{
      id: "w1", title: "One", updated_at: 9, page_count: 1,
      board: { v: 1, elements: [] }, agent: [],
    }]) }));
    expect(restoreWhiteboardNotebook).not.toHaveBeenCalled();
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
  it("waits for ink before publishing an incoming notebook", async () => {
    let finish!: () => void;
    const transfer = new Promise<void>((resolve) => { finish = resolve; });
    const ink = vi.spyOn(inkSync, "syncInkPages").mockImplementationOnce(async () => {
      await transfer;
      return [];
    });
    const client = fakeClient({ pingPadSync: vi.fn(async () => ({
      now: 100, whiteboard: [{ id: "w1", title: "N", updated_at: 40,
        page_count: 1, board: emptyBoard, agent: [] }],
      annotate: [], snapshots: [], gone: [],
    })) });
    const work = applyPadSyncPing(client);
    await vi.waitFor(() => expect(ink).toHaveBeenCalled());
    expect(restoreWhiteboardNotebook).not.toHaveBeenCalled();
    finish();
    await work;
    expect(restoreWhiteboardNotebook).toHaveBeenCalledTimes(1);
  });

  it("leaves the notebook unpublished when its ink transfer fails", async () => {
    vi.spyOn(inkSync, "syncInkPages").mockRejectedValueOnce(new Error("missing ink"));
    await expect(applyPadSyncPing(fakeClient({ pingPadSync: vi.fn(async () => ({
      now: 100, whiteboard: [{ id: "w1", title: "N", updated_at: 40,
        page_count: 1, board: emptyBoard, agent: [] }],
      annotate: [], snapshots: [], gone: [],
    })) }))).rejects.toThrow("missing ink");
    expect(restoreWhiteboardNotebook).not.toHaveBeenCalled();
  });

  it("keeps local pad metadata when either its ink or its saved content conflicts", async () => {
    vi.spyOn(inkSync, "syncInkPages").mockResolvedValueOnce([
      { kind: "whiteboard", key: "w1", pageId: 1, localUpdatedAt: 20, remoteUpdatedAt: 40 },
    ]);
    getWhiteboardNotebook.mockResolvedValue({ id: "w2", updatedAt: 20, hubAckUpdatedAt: 10,
      board: emptyBoard });
    await applyPadSyncPing(fakeClient({ pingPadSync: vi.fn(async () => ({
      now: 100, whiteboard: ["w1", "w2"].map((id) => ({ id, title: "N", updated_at: 40,
        page_count: 1, board: emptyBoard, agent: [] })),
      annotate: [], snapshots: [], gone: [],
    })) }));
    expect(restoreWhiteboardNotebook).not.toHaveBeenCalled();
  });

  it("skips a tick while the camera is moving", async () => {
    noteCameraBusy();
    const pingPadSync = vi.fn(async () => ({
      now: 100,
      whiteboard: [],
      annotate: [],
      snapshots: [],
      gone: [],
    }));
    await applyPadSyncPing(fakeClient({ pingPadSync }));
    expect(pingPadSync).not.toHaveBeenCalled();
  });

  it("never pings when Hub auto-sync is off, even with the hub online", async () => {
    hubAutosyncState.on = false;
    const pingPadSync = vi.fn(async () => ({
      now: 100,
      whiteboard: [],
      annotate: [],
      snapshots: [],
      gone: [],
    }));
    const padHub = await import("./padHub");
    const hubSpy = vi.spyOn(padHub, "loadPadHub").mockReturnValue({
      url: "http://127.0.0.1:9",
      token: "t",
    });
    const client = fakeClient({ pingPadSync });
    await applyPadSyncPing(client);
    expect(pingPadSync).not.toHaveBeenCalled();

    // The idle kick is gated at creation too.
    vi.useFakeTimers();
    scheduleIdlePadSyncPing(client);
    await vi.advanceTimersByTimeAsync(padSyncIdleKickMs() + 10_000);
    expect(pingPadSync).not.toHaveBeenCalled();
    vi.useRealTimers();

    // Turning the pref back on resumes traffic without a remount.
    hubAutosyncState.on = true;
    await applyPadSyncPing(client);
    expect(pingPadSync).toHaveBeenCalledTimes(1);
    hubSpy.mockRestore();
  });

  it("waits longer before the first idle kick on Android", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    expect(padSyncIdleKickMs()).toBe(PAD_SYNC_IDLE_KICK_MS_DESKTOP);
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    expect(padSyncIdleKickMs()).toBe(PAD_SYNC_IDLE_KICK_MS_ANDROID);
  });

  it("backs off after a dead hub instead of retrying immediately", async () => {
    const padHub = await import("./padHub");
    const hubSpy = vi.spyOn(padHub, "loadPadHub").mockReturnValue({
      url: "http://127.0.0.1:9",
      token: "t",
    });
    const pingPadSync = vi.fn(async () => {
      throw new Error("failed to fetch");
    });
    const client = fakeClient({ pingPadSync });
    await expect(applyPadSyncPing(client)).rejects.toThrow(/failed to fetch/);
    pingPadSync.mockClear();
    await applyPadSyncPing(client);
    expect(pingPadSync).not.toHaveBeenCalled();
    hubSpy.mockRestore();
  });

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

  it("keeps one queued upload per document, not one per failed attempt", async () => {
    // Byte jobs were the one kind that did not coalesce, and they are the ones
    // carrying a whole PDF: every failed upload added another full copy to
    // memory and to IndexedDB, so an unreachable hub filled the device with
    // duplicates of one book.
    const bytes = () => new ArrayBuffer(1024);
    await enqueuePadSync({ op: "putBytes", hash: "h1:1024", bytes: bytes() });
    await enqueuePadSync({ op: "putBytes", hash: "h1:1024", bytes: bytes() });
    await enqueuePadSync({ op: "putBytes", hash: "h1:1024", bytes: bytes() });

    const queued = peekPadSyncQueueForTests().filter((job) => job.op === "putBytes");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ op: "putBytes", hash: "h1:1024" });
  });

  it("keeps a different document's upload", async () => {
    await enqueuePadSync({ op: "putBytes", hash: "h1:8", bytes: new ArrayBuffer(8) });
    await enqueuePadSync({ op: "putBytes", hash: "h2:8", bytes: new ArrayBuffer(8) });
    expect(peekPadSyncQueueForTests().filter((job) => job.op === "putBytes")).toHaveLength(2);
  });

  it("refuses a document the hub could never accept, instead of queueing it", async () => {
    const padHub = await import("./padHub");
    const hubSpy = vi.spyOn(padHub, "loadPadHub").mockReturnValue({
      url: "http://hub.test",
      token: "t",
    });
    const client = fakeClient();
    const tooBig = new ArrayBuffer(padHub.HUB_MAX_BODY_BYTES + 1);

    await expect(pushDocBytes(client, "big:1", tooBig)).rejects.toThrow(/at most/);
    expect(peekPadSyncQueueForTests().filter((job) => job.op === "putBytes")).toHaveLength(0);
    hubSpy.mockRestore();
  });

  it("refuses an oversize annotate PUT instead of queueing it", async () => {
    setPadSyncBodyCapForTests(80);
    const client = fakeClient();
    await expect(
      pushAnnotatePad(client, {
        id: "a1",
        name: "book.pdf",
        hash: "h",
        docType: "pdf",
        updatedAt: 1,
        source: "x".repeat(400),
        board: emptyBoard,
      }),
    ).rejects.toThrow(/at most/);
    expect(client.putAnnotatePad).not.toHaveBeenCalled();
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
  });

  it("drops an oversized annotate job so a later whiteboard PUT still flushes", async () => {
    setPadSyncBodyCapForTests(80);
    const client = fakeClient();
    await enqueuePadSync({
      op: "putAnnotate",
      body: {
        id: "a1",
        name: "book.pdf",
        hash: "h",
        doc_type: "pdf",
        updated_at: 1,
        source: "x".repeat(400),
        footnotes: [],
        board: emptyBoard,
        agent: [],
      },
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
    await flushPadSyncQueue(client);
    expect(client.putAnnotatePad).not.toHaveBeenCalled();
    expect(client.putWhiteboardPad).toHaveBeenCalledTimes(1);
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
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

  it("ships ink, edges and source on the snapshot payload", async () => {
    const client = fakeClient();
    const artifactBundle = {
      v: 1 as const, catalog: { v: 1 as const, parent: { kind: "annotate" as const, id: "a1" }, revision: "c1", artifacts: [] }, assets: [],
    };
    await pushPadSnapshot(client, {
      kind: "annotate",
      key: "a1",
      tier: "24h",
      writtenAt: 2,
      name: "notes.md",
      board: emptyBoard,
      source: "# hi",
      artifactBundle,
      footnoteBoards: { scratch1: { board: emptyBoard, pageCount: 1 } },
      footnoteInk: { scratch1: [{ pageId: 0, updatedAt: 9, gz: "YQ==" }] },
      ink: [{ pageId: 3, updatedAt: 9, gz: "YQ==" }],
      edges: [
        {
          id: "picker|annotate:a1|annotate:a2",
          from: { type: "annotate", id: "a1" },
          to: { type: "annotate", id: "a2" },
          kind: "picker",
          createdAt: 1,
        },
      ],
    });
    expect(client.putPadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          source: "# hi",
          artifactBundle,
          footnoteBoards: { scratch1: { board: emptyBoard, pageCount: 1 } },
          footnoteInk: { scratch1: [{ pageId: 0, updatedAt: 9, gz: "YQ==" }] },
          ink: [{ pageId: 3, updatedAt: 9, gz: "YQ==" }],
          edges: [expect.objectContaining({ id: "picker|annotate:a1|annotate:a2" })],
        }),
      }),
    );
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
    const result = await restoreTrashedPad(client, "whiteboard", "w1");
    expect(result).toEqual({ ok: true, title: "One" });
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

  it("preserves the local notebook on 409 and leaves resolution to explicit Sync", async () => {
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
    expect(restoreWhiteboardNotebook).not.toHaveBeenCalled();
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

  it("does not replace problem attachments with a conflicting server board", async () => {
    const id = "leetcode/two-sum";
    getProblemBoard.mockResolvedValue({ id, dataset: "leetcode", taskId: "two-sum", updatedAt: 999,
      hubAckUpdatedAt: 1, board: emptyBoard, agent: [], artifacts: {
      v: 1, parent: { kind: "problem", id }, revision: "local", artifacts: [],
    } });
    const hub = { id, board: emptyBoard, updated_at: 40 };
    const client = fakeClient({ putProblemPad: vi.fn(async () => {
      throw new LcApiError("conflict", 409, JSON.stringify(hub), hub);
    }) });
    await expect(pushProblemPad(client, { id, dataset: "leetcode", taskId: "two-sum",
      updatedAt: 999, hubAckUpdatedAt: 1, board: emptyBoard, agent: [],
    })).resolves.toBe(false);
    expect(client.putProblemPad).toHaveBeenCalledWith("leetcode", "two-sum", expect.objectContaining({ artifacts: expect.objectContaining({ revision: "local" }) }));
    expect(putProblemBoard).not.toHaveBeenCalled();
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

  it("serializes overlapping problem saves", async () => {
    const row = { id: "d/1", dataset: "d", taskId: "1", updatedAt: 10, board: emptyBoard, agent: [] };
    getProblemBoard.mockResolvedValue(row);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const put = vi.fn(async () => { await blocked; return { updated_at: 10 }; });
    const client = fakeClient({ putProblemPad: put as never });
    const first = pushProblemPad(client, row);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const second = pushProblemPad(client, row);
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("retries the current problem catalog instead of an obsolete queued version", async () => {
    const artifacts = { v: 1, parent: { kind: "problem", id: "d/1" }, revision: "new", artifacts: [] };
    getProblemBoard.mockResolvedValue({ id: "d/1", dataset: "d", taskId: "1", updatedAt: 20, board: emptyBoard, artifacts });
    await enqueuePadSync({ op: "putProblem", body: { id: "d/1", dataset: "d", task_id: "1", updated_at: 10, board: emptyBoard, agent: [] } });
    const client = fakeClient();
    await flushPadSyncQueue(client);
    expect(client.putProblemPad).toHaveBeenCalledWith("d", "1", expect.objectContaining({ updated_at: 20, artifacts }));
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

describe("applyHubAnnotate footnote boards", () => {
  it("carries validated catalogs through document upload and download", async () => {
    const artifacts: ArtifactCatalog = {
      v: 1, parent: { kind: "annotate", id: "a1" }, revision: "c1", artifacts: [],
    };
    const body = await annotatePadBody({
      id: "a1", name: "n.md", hash: "h", docType: "markdown", updatedAt: 40,
      source: "#", board: emptyBoard, footnotes: [], agent: [], artifacts,
    });
    expect(body.artifacts).toEqual(artifacts);
    await applyHubAnnotate(body, { emitReload: false });
    expect(restoreAnnotateDoc).toHaveBeenCalledWith(expect.objectContaining({ artifacts }));
  });

  it("carries validated catalogs through notebook upload and download", async () => {
    const artifacts: ArtifactCatalog = {
      v: 1, parent: { kind: "whiteboard", id: "w1" }, revision: "c1", artifacts: [],
    };
    const body = whiteboardPadBody({
      id: "w1", title: "Notebook", updatedAt: 40, pageCount: 1,
      board: emptyBoard, agent: [], artifacts,
    });
    expect(body.artifacts).toEqual(artifacts);
    await applyHubWhiteboard(body, { emitReload: false });
    expect(restoreWhiteboardNotebook).toHaveBeenCalledWith(expect.objectContaining({ artifacts }));
  });

  it("rejects foreign catalogs before replacing a local document", async () => {
    const artifacts: ArtifactCatalog = {
      v: 1, parent: { kind: "annotate", id: "other" }, revision: "c1", artifacts: [],
    };
    restoreAnnotateDoc.mockClear();
    await expect(applyHubAnnotate({
      id: "a1", name: "n.md", hash: "h", doc_type: "markdown", updated_at: 40,
      source: "#", board: emptyBoard, footnotes: [], agent: [], artifacts,
    }, { emitReload: false })).rejects.toThrow("different parent");
    expect(restoreAnnotateDoc).not.toHaveBeenCalled();
  });

  it("does not upload or queue a parent after a scratch dependency read fails", async () => {
    const client = fakeClient();
    const unavailable = new Error("Missing attached whiteboard");
    footnoteBoardMocks.collectFootnoteBoards.mockRejectedValueOnce(unavailable);
    await expect(pushAnnotatePad(client, {
      id: "a1", name: "n.md", hash: "h", docType: "markdown", updatedAt: 40,
      source: "#", board: emptyBoard, footnotes: [], agent: [],
    })).rejects.toBe(unavailable);
    expect(client.putAnnotatePad).not.toHaveBeenCalled();
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
  });

  it("puts collected boards on the annotate PUT body", async () => {
    const boards = {
      "wb-1": { board: emptyBoard, pageCount: 1 },
    };
    footnoteBoardMocks.collectFootnoteBoards.mockResolvedValue(boards);
    const body = await annotatePadBody({
      id: "a1",
      name: "n.md",
      hash: "h",
      docType: "markdown",
      updatedAt: 40,
      source: "#",
      footnotes: [
        {
          id: "f1",
          kind: "note",
          anchor: { kind: "text", start: 0, end: 1 },
          excerpt: "x",
          createdAt: 1,
          whiteboards: [{ id: "wb-1", createdAt: 1, updatedAt: 1 }],
        },
      ],
      board: emptyBoard,
      agent: [],
    });
    expect(footnoteBoardMocks.collectFootnoteBoards).toHaveBeenCalledWith(
      "a1", expect.any(Array), { slim: true, requireAll: true },
    );
    expect(body.footnote_boards).toEqual(boards);
  });

  it("puts a display label on the annotate PUT body without changing the URL name", async () => {
    const body = await annotatePadBody({
      id: "a1",
      name: "https://example.com/page",
      label: "Reading list",
      hash: "h",
      docType: "web",
      updatedAt: 40,
      source: "<html></html>",
      footnotes: [],
      board: emptyBoard,
      agent: [],
    });
    expect(body.label).toBe("Reading list");
    expect(body.name).toBe("https://example.com/page");
  });

  it("writes footnote_boards into the KV store", async () => {
    const boards = {
      "wb-1": {
        board: { v: 1 as const, elements: [{ id: "scratch" }], appState: { scrollX: 0, scrollY: 0, zoom: 1 } },
        pageCount: 1,
      },
    };
    await applyHubAnnotate(
      {
        id: "a1",
        name: "n.md",
        hash: "h",
        doc_type: "markdown",
        updated_at: 40,
        source: "#",
        footnotes: [{ id: "f1", kind: "note", whiteboards: [{ id: "wb-1" }] }],
        board: emptyBoard,
        agent: [],
        footnote_boards: boards,
      },
      { emitReload: false },
    );
    expect(restoreAnnotateDoc).toHaveBeenCalled();
    expect(footnoteBoardMocks.applyFootnoteBoards).toHaveBeenCalledWith("a1", boards);
  });
});
