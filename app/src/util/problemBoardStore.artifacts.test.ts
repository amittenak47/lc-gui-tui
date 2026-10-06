import { memoryBookTransaction } from "./testBookTransaction";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editProblemArtifacts, getProblemBoard, markProblemHubAck, putProblemBoard, replaceProblemBoard, type ProblemBoardRecord } from "./problemBoardStore";
import type { ArtifactCatalogEdit } from "./artifactCatalogEdits";

const state = vi.hoisted(() => ({
  rows: new Map<string, ProblemBoardRecord>(), meta: new Map<string, any>(), sync: new Map<string, any>(),
  preflight: undefined as (() => void) | undefined,
  missing: false,
}));
vi.mock("./artifactAssetSync", () => ({ downloadArtifactAssets: async () => {
  if (state.missing) throw new Error("missing attachment");
  state.preflight?.();
} }));
vi.mock("./idb", async original => ({
  ...await original<typeof import("./idb")>(),
  STORE_PROBLEM_BOARDS: "problem_boards",
  run: async (_store: string, _mode: string, work: (store: unknown) => { result: unknown }) => work({
    get: (id: string) => ({ result: structuredClone(state.rows.get(id)) }),
  }).result,
  withTransaction: async (_names: string[], _mode: string, work: any) => memoryBookTransaction(new Map([
    ["problem_boards", state.rows as Map<string, unknown>], ["book_meta", state.meta], ["sync_state", state.sync],
  ]), work),
}));
const id = "leetcode/1";
const create: ArtifactCatalogEdit = { type: "create", id: "a1", title: "Note.md", associations: [{ kind: "file" }],
  content: { kind: "markdown", documentId: "doc1", sourceRevision: "s1" } };
beforeEach(() => {
  state.rows.clear(); state.meta.clear(); state.sync.clear(); state.preflight = undefined; state.missing = false;
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
    await markProblemHubAck(id, 20);
    await markProblemHubAck(id, 10);
    expect(state.rows.get(id)).toEqual({ ...before, hubAckUpdatedAt: 20 });
  });
});
