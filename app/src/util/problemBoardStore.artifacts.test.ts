import { beforeEach, describe, expect, it, vi } from "vitest";
import { editProblemArtifacts, getProblemBoard, markProblemHubAck, putProblemBoard, replaceProblemBoard, type ProblemBoardRecord } from "./problemBoardStore";
import type { ArtifactCatalogEdit } from "./artifactCatalogEdits";

const state = vi.hoisted(() => ({
  rows: new Map<string, ProblemBoardRecord>(),
  preflight: undefined as (() => void) | undefined,
  missing: false,
}));
vi.mock("./artifactAssetSync", () => ({ downloadArtifactAssets: async () => {
  if (state.missing) throw new Error("missing attachment");
  state.preflight?.();
} }));
vi.mock("./idb", () => ({
  STORE_PROBLEM_BOARDS: "problem_boards",
  run: async (_store: string, _mode: string, work: (store: unknown) => { result: unknown }) => work({
    get: (id: string) => ({ result: structuredClone(state.rows.get(id)) }),
  }).result,
  withStore: async (_name: string, _mode: string, work: (store: unknown) => void) => {
    const writes = new Map<string, ProblemBoardRecord>();
    const reads: Array<{ result: unknown; onsuccess?: () => void }> = [];
    let aborted = false;
    work({
      transaction: { abort: () => { aborted = true; } },
      get: (id: string) => {
        const req = { result: structuredClone(state.rows.get(id)), onsuccess: undefined as (() => void) | undefined };
        reads.push(req); return req;
      },
      put: (row: ProblemBoardRecord, id: string) => writes.set(id, structuredClone(row)),
    });
    for (const read of reads) read.onsuccess?.();
    if (aborted) throw new Error("transaction aborted");
    for (const [id, row] of writes) state.rows.set(id, row);
  },
}));
const id = "leetcode/1";
const create: ArtifactCatalogEdit = { type: "create", id: "a1", title: "Note.md", associations: [{ kind: "file" }],
  content: { kind: "markdown", documentId: "doc1", sourceRevision: "s1" } };
beforeEach(() => {
  state.rows.clear(); state.preflight = undefined; state.missing = false;
  state.rows.set(id, { id, dataset: "leetcode", taskId: "1", updatedAt: 1, syncSeq: 4,
    board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } } });
});

describe("atomic problem attachment catalog edits", () => {
  it("a conflict/download replacement cannot overwrite a newer board", async () => {
    const old = structuredClone(state.rows.get(id)!);
    state.preflight = () => state.rows.set(id, { ...old, updatedAt: 20, agent: ["new local work"] });
    await expect(replaceProblemBoard(old, { ...old, updatedAt: 30, agent: ["remote"] })).rejects.toThrow("changed since");
    expect(state.rows.get(id)?.agent).toEqual(["new local work"]);
  });
  it("preserves newer board/chat writes made during dependency preflight", async () => {
    state.preflight = () => {
      const row = state.rows.get(id)!;
      state.rows.set(id, { ...row, board: { ...row.board, elements: [{ id: "new-shape" }] }, agent: ["new message"], updatedAt: 10 });
    };
    const catalog = await editProblemArtifacts(id, null, create);
    expect(await getProblemBoard(id)).toMatchObject({ artifacts: catalog, syncSeq: 4,
      board: { elements: [{ id: "new-shape" }] }, agent: ["new message"] });
  });

  it("rechecks the base revision in the transaction", async () => {
    const winner = await editProblemArtifacts(id, null, create);
    state.rows.set(id, { ...state.rows.get(id)!, artifacts: undefined });
    state.preflight = () => state.rows.set(id, { ...state.rows.get(id)!, artifacts: winner });
    await expect(editProblemArtifacts(id, null, { ...create, id: "loser" })).rejects.toThrow("changed since");
    expect(state.rows.get(id)?.artifacts).toEqual(winner);
  });

  it("does not publish missing dependencies or resurrect a removed parent", async () => {
    state.missing = true;
    await expect(editProblemArtifacts(id, null, create)).rejects.toThrow("missing attachment");
    expect(state.rows.get(id)?.artifacts).toBeUndefined();
    state.missing = false;
    state.preflight = () => { state.rows.delete(id); };
    await expect(editProblemArtifacts(id, null, create)).rejects.toThrow("changed since");
    expect(state.rows.has(id)).toBe(false);
  });

  it("ordinary saves keep tombstones and reject silent resurrection", async () => {
    const first = await editProblemArtifacts(id, null, create);
    const deleted = await editProblemArtifacts(id, first.revision, { type: "delete", id: "a1", expectedRevision: first.artifacts[0].revision });
    await putProblemBoard({ ...state.rows.get(id)!, artifacts: undefined });
    expect(state.rows.get(id)?.artifacts).toEqual(deleted);
    await expect(putProblemBoard({ ...state.rows.get(id)!, artifacts: first })).rejects.toThrow("Restoring");
    expect(state.rows.get(id)?.artifacts).toEqual(deleted);
  });

  it("an ordinary board save cannot roll back a newer live catalog", async () => {
    const first = await editProblemArtifacts(id, null, create);
    const second = await editProblemArtifacts(id, first.revision, { type: "update", id: "a1", expectedRevision: first.artifacts[0].revision,
      patch: { title: "New title" } });
    await expect(putProblemBoard({ ...state.rows.get(id)!, artifacts: first })).rejects.toThrow("changed since");
    expect(state.rows.get(id)?.artifacts).toEqual(second);
  });

  it("acknowledgement updates only the ack and never lowers it", async () => {
    await editProblemArtifacts(id, null, create);
    const before = structuredClone(state.rows.get(id)!);
    markProblemHubAck(id, 20);
    markProblemHubAck(id, 10);
    expect(state.rows.get(id)).toEqual({ ...before, hubAckUpdatedAt: 20 });
  });
});
