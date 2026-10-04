/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LcApiError, type LcClient, type ProblemPadDto } from "../api/client";
import { savePadHub, setHostLoopback } from "./padHub";
import { beginPadHubStatusRequest, refreshPadHubStatus, reportPadHubStatus } from "./padHubStatus";
import {
  applyPadSyncPing, enqueuePadSync, flushPadSyncQueue, peekPadSyncQueueForTests, pushAnnotatePad,
  pushDocBytes, pushPadSnapshot, pushProblemPad, pushWhiteboardPad,
  resetPadSyncQueueForTests, restoreTrashedPad, startPadSyncRecovery, tombstonePad, waitForPadPushes,
} from "./padSync";

const state = vi.hoisted(() => ({
  persisted: new Map<string, unknown>(), failPut: false,
  notify: vi.fn(), whiteboardAck: vi.fn(), annotateAck: vi.fn(), problemAck: vi.fn(),
  applyWhiteboard: vi.fn(async () => {}),
  acceptProblemAgent: vi.fn(async () => {}),
  deleteProblem: vi.fn(async () => {}),
  getProblem: vi.fn(async (): Promise<unknown> => null),
  getWhiteboard: vi.fn(async (): Promise<unknown> => null),
  restoreWhiteboard: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("./idb", async () => ({
  ...await vi.importActual("./idb"),
  run: async (name: string, _mode: unknown, work: (store: unknown) => { result: unknown }) => {
    const store = {
      getAll: () => ({ result: name === "pad_sync_queue" ? [...state.persisted.values()] : [] }),
      put: (job: unknown, id: string) => {
        if (state.failPut) throw new Error("quota");
        if (name === "pad_sync_queue") state.persisted.set(id, job);
        return { result: id };
      },
      delete: (id: string) => { state.persisted.delete(id); return { result: undefined }; },
      get: () => ({ result: undefined }),
    };
    return work(store).result;
  },
}));
vi.mock("./notifications", () => ({ showNotification: state.notify }));
vi.mock("./contentStore", () => ({ putParentContent: async () => {} }));
vi.mock("./inkSync", () => ({ syncInkPages: async () => [], syncEdges: async () => {} }));
vi.mock("./footnoteWhiteboardStore", () => ({ collectFootnoteBoards: async () => ({}), applyFootnoteBoards: async () => {} }));
vi.mock("./whiteboardStore", () => ({
  getWhiteboardNotebook: state.getWhiteboard,
  listWhiteboardNotebooks: () => [], listWhiteboardTrash: () => [],
  markWhiteboardHubAck: state.whiteboardAck, markWhiteboardDeleteAcked: vi.fn(),
  restoreWhiteboardNotebook: state.applyWhiteboard,
  restoreWhiteboardFromTrash: state.restoreWhiteboard,
}));
vi.mock("./annotateStore", () => ({
  getAnnotateDoc: async () => null, listAnnotateDocs: () => [], listAnnotateTrash: () => [],
  markAnnotateHubAck: state.annotateAck, markAnnotateDeleteAcked: vi.fn(),
}));
vi.mock("./problemBoardStore", () => ({
  getProblemBoard: state.getProblem, deleteProblemBoard: state.deleteProblem,
  markProblemHubAck: state.problemAck, acceptProblemHubAgent: state.acceptProblemAgent,
}));

const HUB = { url: "http://offline.test", token: "123456" };
const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const notebook = { id: "w1", title: "One", updatedAt: 10, pageCount: 1, board, agent: [] };
const problem = { id: "d/1", dataset: "d", taskId: "1", updatedAt: 10, board };
const cleanup: Array<() => void> = [];

function status(value: "online" | "offline"): void {
  reportPadHubStatus(beginPadHubStatusRequest(HUB), value);
}

function client(): LcClient {
  return {
    putWhiteboardPad: vi.fn(async () => ({ updated_at: 10 })),
    putAnnotatePad: vi.fn(async () => ({ updated_at: 10 })),
    putProblemPad: vi.fn(async () => ({ updated_at: 10 })),
    putDocBytes: vi.fn(async () => {}), putPadSnapshot: vi.fn(async () => {}),
    tombstoneProblemPad: vi.fn(async () => ({ applied: true, seq: 1 })),
    tombstoneWhiteboardPad: vi.fn(async () => ({ applied: true, seq: 1 })),
  } as unknown as LcClient;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("whiteboard.hubAutoSync.v1", "on");
  state.persisted.clear();
  state.failPut = false;
  vi.clearAllMocks();
  state.getProblem.mockReset().mockResolvedValue(null);
  state.getWhiteboard.mockReset().mockResolvedValue(null);
  state.restoreWhiteboard.mockResolvedValue(null);
  resetPadSyncQueueForTests();
  setHostLoopback(null);
  savePadHub(HUB);
  refreshPadHubStatus();
  status("offline");
});

afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  savePadHub(null);
  refreshPadHubStatus();
});

describe("offline hub sync", () => {
  it("queues every kind of write without starting a request or marking it synced", async () => {
    const api = client();
    await pushWhiteboardPad(api, notebook);
    await pushAnnotatePad(api, { id: "a1", name: "note", hash: "h", docType: "markdown", source: "text", updatedAt: 10, board });
    await pushProblemPad(api, problem);
    await pushDocBytes(api, "h", new ArrayBuffer(4));
    await pushPadSnapshot(api, { kind: "whiteboard", key: "w1", tier: "24h", writtenAt: 10, name: "One", board });
    await tombstonePad(api, "problem", "d/2", 1);
    await flushPadSyncQueue(api);
    for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled();
    expect(state.whiteboardAck).not.toHaveBeenCalled();
    expect(state.annotateAck).not.toHaveBeenCalled();
    expect(state.problemAck).not.toHaveBeenCalled();
    expect(state.persisted.size).toBe(6);
    expect(state.notify).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledWith("Desktop app is offline — this will sync when it's back.");
  });

  it("flushes once when health recovers and ignores repeated online reports", async () => {
    const api = client();
    cleanup.push(startPadSyncRecovery(api));
    await tombstonePad(api, "problem", "d/1", 1);
    expect(api.tombstoneProblemPad).not.toHaveBeenCalled();
    status("online");
    status("online");
    await flushPadSyncQueue(api);
    expect(api.tombstoneProblemPad).toHaveBeenCalledTimes(1);
    expect(state.persisted.size).toBe(0);
    expect(state.deleteProblem).not.toHaveBeenCalled();
  });

  it("hydrates a durable tombstone after all queue memory is reset for a restart", async () => {
    const api = client();
    await tombstonePad(api, "problem", "d/1", 2);
    resetPadSyncQueueForTests();
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
    status("online");
    await flushPadSyncQueue(api);
    expect(api.tombstoneProblemPad).toHaveBeenCalledWith("d", "1", 2);
    expect(state.persisted.size).toBe(0);
  });

  it("persists a tombstone before an online request that never resolves", async () => {
    const api = client();
    status("online");
    api.tombstoneProblemPad = vi.fn(() => new Promise<never>(() => {}));
    void tombstonePad(api, "problem", "d/1", 1);
    await vi.waitFor(() => expect(api.tombstoneProblemPad).toHaveBeenCalledTimes(1));
    expect([...state.persisted.values()]).toMatchObject([{ op: "deletePad", padId: "d/1" }]);
  });

  it("retains a rejected tombstone without deleting a newly opened local board", async () => {
    const api = client();
    state.getProblem.mockResolvedValue(problem);
    await tombstonePad(api, "problem", "d/1", 1);
    state.getProblem.mockResolvedValue({ ...problem, updatedAt: 20 });
    api.tombstoneProblemPad = vi.fn(async () => ({ applied: false, seq: 2 }));
    status("online");
    await flushPadSyncQueue(api);
    expect(peekPadSyncQueueForTests()).toMatchObject([{ op: "deletePad", seq: 1 }]);
    expect(state.deleteProblem).not.toHaveBeenCalled();
  });

  it("coalesces recovery and a direct tombstone when its response marks the hub online", async () => {
    const api = client();
    savePadHub(null);
    refreshPadHubStatus();
    savePadHub(HUB);
    refreshPadHubStatus();
    cleanup.push(startPadSyncRecovery(api));
    api.tombstoneProblemPad = vi.fn(async () => {
      status("online");
      return { applied: true, seq: 1 };
    });
    await tombstonePad(api, "problem", "d/1", 1);
    await flushPadSyncQueue(api);
    expect(api.tombstoneProblemPad).toHaveBeenCalledTimes(1);
  });

  it("keeps a tombstone if a response has no explicit acknowledgement", async () => {
    const api = client();
    await tombstonePad(api, "problem", "d/1", 1);
    api.tombstoneProblemPad = vi.fn(async () => ({})) as unknown as LcClient["tombstoneProblemPad"];
    status("online");
    await flushPadSyncQueue(api);
    expect(peekPadSyncQueueForTests()).toMatchObject([{ op: "deletePad" }]);
  });

  it("leaves queued and reopened problem work intact when recovery ping reports it deleted", async () => {
    const api = client();
    await pushProblemPad(api, problem);
    state.getProblem.mockResolvedValue({ ...problem, updatedAt: 20 });
    api.pingPadSync = vi.fn(async () => ({
      now: 100, whiteboard: [], annotate: [], snapshots: [],
      gone: [{ kind: "problem", id: "d/1", seq: 1, gone_at: 50 }], ink: [],
    }));
    status("online");
    await applyPadSyncPing(api);
    expect(api.pingPadSync).toHaveBeenCalledTimes(1);
    expect(peekPadSyncQueueForTests()).toMatchObject([{ op: "putProblem" }]);
    expect(state.deleteProblem).not.toHaveBeenCalled();
  });

  it("preserves a PUT queued while the ping is awaiting the local whiteboard", async () => {
    const api = client();
    status("online");
    let completeRead!: (value: unknown) => void;
    state.getWhiteboard.mockImplementationOnce(() => new Promise((resolve) => { completeRead = resolve; }));
    api.pingPadSync = vi.fn(async () => ({
      now: 100, whiteboard: [{ id: "w1", title: "Remote", updated_at: 50, page_count: 1, board, agent: [] }],
      annotate: [], snapshots: [], gone: [], ink: [],
    }));
    const ping = applyPadSyncPing(api);
    await vi.waitFor(() => expect(state.getWhiteboard).toHaveBeenCalledTimes(1));
    await enqueuePadSync({ op: "putWhiteboard", body: {
      id: "w1", title: "Local", updated_at: 20, page_count: 1, board, agent: [],
    } });
    completeRead({ ...notebook, hubAckUpdatedAt: notebook.updatedAt });
    await ping;
    expect(peekPadSyncQueueForTests()).toMatchObject([{ op: "putWhiteboard", body: { updated_at: 20 } }]);
    expect(state.applyWhiteboard).not.toHaveBeenCalled();
    expect(state.whiteboardAck).not.toHaveBeenCalled();
  });

  it("retains an unsent problem payload if its local working copy has become a different acknowledged remote revision", async () => {
    const api = client();
    await pushProblemPad(api, problem);
    state.getProblem.mockResolvedValue({ ...problem, updatedAt: 50, hubAckUpdatedAt: 50 });
    status("online");
    await flushPadSyncQueue(api);
    expect(api.putProblemPad).not.toHaveBeenCalled();
    expect(peekPadSyncQueueForTests()).toMatchObject([{ op: "putProblem", body: { updated_at: 10 } }]);
    expect(state.problemAck).not.toHaveBeenCalled();
  });

  it("releases a pending push wait as soon as the probe detects offline", async () => {
    const api = client();
    status("online");
    api.putWhiteboardPad = vi.fn(() => new Promise<never>(() => {}));
    void pushWhiteboardPad(api, notebook);
    const waiting = waitForPadPushes("whiteboard", "w1");
    status("offline");
    await waiting;
    expect(api.putWhiteboardPad).toHaveBeenCalledTimes(1);
  });

  it("keeps the last durable change if persisting its replacement fails", async () => {
    await enqueuePadSync({ op: "putBytes", hash: "h", bytes: new ArrayBuffer(4) });
    const original = [...state.persisted.keys()][0];
    state.failPut = true;
    await enqueuePadSync({ op: "putBytes", hash: "h", bytes: new ArrayBuffer(4) });
    expect(state.persisted.has(original)).toBe(true);
    expect(peekPadSyncQueueForTests()).toHaveLength(1);
  });

  it("reports required tombstone persistence failure and keeps both the prior durable job and memory retry", async () => {
    const api = client();
    await enqueuePadSync({ op: "deletePad", kind: "problem", padId: "d/1", seq: 1 });
    const durableId = [...state.persisted.keys()][0];
    state.failPut = true;
    await expect(enqueuePadSync(
      { op: "deletePad", kind: "problem", padId: "d/1", seq: 2 },
      { requirePersistence: true },
    )).rejects.toThrow();
    expect(state.persisted.has(durableId)).toBe(true);
    expect(peekPadSyncQueueForTests()).toMatchObject([
      { op: "deletePad", seq: 1 }, { op: "deletePad", seq: 2 },
    ]);
    expect(api.tombstoneProblemPad).not.toHaveBeenCalled();
  });

  it("supersedes the cleared revision while preserving a newer queued problem edit", async () => {
    state.getProblem.mockResolvedValue(problem);
    await enqueuePadSync({ op: "putProblem", body: {
      id: "d/1", dataset: "d", task_id: "1", updated_at: 20, board, agent: [],
    } });
    await tombstonePad(client(), "problem", "d/1", 1);
    expect(peekPadSyncQueueForTests()).toMatchObject([
      { op: "putProblem", body: { updated_at: 20 } }, { op: "deletePad", supersededUpdatedAt: 10 },
    ]);
    state.getProblem.mockResolvedValue({ ...problem, updatedAt: 20 });
    await tombstonePad(client(), "problem", "d/1", 1);
    expect(peekPadSyncQueueForTests()).toHaveLength(2);
    expect(peekPadSyncQueueForTests()[1]).toMatchObject({ op: "deletePad", supersededUpdatedAt: 10 });
  });

  it("does not merge an old in-flight save acknowledgement into a reopened attempt", async () => {
    const api = client();
    status("online");
    state.getProblem.mockResolvedValue(problem);
    let complete!: (written: ProblemPadDto) => void;
    api.putProblemPad = vi.fn(() => new Promise<ProblemPadDto>((resolve) => { complete = resolve; }));
    const saving = pushProblemPad(api, problem);
    await vi.waitFor(() => expect(api.putProblemPad).toHaveBeenCalledTimes(1));
    status("offline");
    await tombstonePad(api, "problem", "d/1", 1);
    state.getProblem.mockResolvedValue({ ...problem, updatedAt: 20 });
    complete({ id: "d/1", dataset: "d", task_id: "1", updated_at: 10, board, agent: [] });
    await saving;
    expect(state.acceptProblemAgent).not.toHaveBeenCalled();
    expect(state.problemAck).not.toHaveBeenCalled();
  });

  it("keeps pending deletion if restoring locally fails", async () => {
    const api = client();
    await tombstonePad(api, "whiteboard", "w1", 1);
    expect(await restoreTrashedPad(api, "whiteboard", "w1")).toEqual({ ok: false });
    expect(peekPadSyncQueueForTests()).toMatchObject([{ op: "deletePad", padId: "w1" }]);
  });

  it("preserves queued puts on conflict and remote tombstone while flushing unrelated jobs", async () => {
    const api = client();
    await pushWhiteboardPad(api, notebook);
    await pushDocBytes(api, "h", new ArrayBuffer(4));
    api.putWhiteboardPad = vi.fn(async () => { throw new LcApiError("gone", 410); });
    status("online");
    await flushPadSyncQueue(api);
    expect(peekPadSyncQueueForTests()).toMatchObject([{ op: "putWhiteboard" }]);
    expect(api.putDocBytes).toHaveBeenCalledTimes(1);
    api.putWhiteboardPad = vi.fn(async () => { throw new LcApiError("conflict", 409); });
    await flushPadSyncQueue(api);
    expect(peekPadSyncQueueForTests()).toHaveLength(1);
    expect(state.whiteboardAck).not.toHaveBeenCalled();
  });

  it.each([
    ["whiteboard", 409], ["whiteboard", 410], ["annotate", 409],
    ["annotate", 410], ["problem", 409], ["problem", 410],
  ] as const)("preserves prior offline %s work when a foreground save returns %s", async (kind, code) => {
    const api = client();
    const doc = { id: "a1", name: "note", hash: "h", docType: "markdown" as const, source: "text", updatedAt: 10, board };
    const save = () => kind === "whiteboard" ? pushWhiteboardPad(api, notebook) :
      kind === "annotate" ? pushAnnotatePad(api, doc) : pushProblemPad(api, problem);
    await save();
    const before = peekPadSyncQueueForTests();
    const fail = vi.fn(async () => { throw new LcApiError("conflict", code, "", {
      id: "d/1", dataset: "d", task_id: "1", updated_at: 50, board, agent: [],
    }); });
    api.putWhiteboardPad = fail;
    api.putAnnotatePad = fail;
    api.putProblemPad = fail;
    state.getProblem.mockResolvedValue(problem);
    status("online");
    await expect(save()).resolves.toBe(false);
    expect(peekPadSyncQueueForTests()).toEqual(before);
    expect(state.deleteProblem).not.toHaveBeenCalled();
    expect(state.whiteboardAck).not.toHaveBeenCalled();
    expect(state.annotateAck).not.toHaveBeenCalled();
    expect(state.problemAck).not.toHaveBeenCalled();
  });

  it("shares a drain and also sends a replacement queued during an in-flight PUT", async () => {
    const api = client();
    await pushWhiteboardPad(api, notebook);
    status("online");
    let complete!: (written: { updated_at: number }) => void;
    api.putWhiteboardPad = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
      .mockResolvedValue({ updated_at: 20 });
    const first = flushPadSyncQueue(api);
    const second = flushPadSyncQueue(api);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(api.putWhiteboardPad).toHaveBeenCalledTimes(1));
    await enqueuePadSync({ op: "putWhiteboard", body: { id: "w1", title: "New", updated_at: 20, page_count: 1, board, agent: [] } });
    complete({ updated_at: 10 });
    await first;
    expect(api.putWhiteboardPad).toHaveBeenCalledTimes(2);
    expect(peekPadSyncQueueForTests()).toHaveLength(0);
    expect(state.persisted.size).toBe(0);
  });

  it("retries a queued current problem only once per drain if the reachable hub returns 503", async () => {
    const api = client();
    await pushProblemPad(api, problem);
    state.getProblem.mockResolvedValue(problem);
    api.putProblemPad = vi.fn(async () => { throw new LcApiError("busy", 503); });
    status("online");
    await flushPadSyncQueue(api);
    expect(api.putProblemPad).toHaveBeenCalledTimes(1);
    expect(peekPadSyncQueueForTests()).toMatchObject([{ op: "putProblem" }]);
  });
});
