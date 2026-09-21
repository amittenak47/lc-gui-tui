import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactParent } from "./padArtifacts";
import { artifactAssetKey, parseArtifactAsset, type ArtifactAsset, type ArtifactAssetLocator } from "./artifactAssets";
import { loadWhiteboardArtifactSnapshot, stageWhiteboardArtifactSnapshot, type ArtifactWhiteboardSnapshot } from "./artifactWhiteboards";

const state = vi.hoisted(() => ({ cache: new Map<string, ArtifactAsset>(), writes: 0, failAt: 0 }));
vi.mock("./artifactAssetStore", () => ({
  getArtifactAsset: async (locator: ArtifactAssetLocator) => state.cache.get(artifactAssetKey(locator)) ?? null,
  putArtifactAsset: async (asset: ArtifactAsset) => {
    state.writes++;
    if (state.writes === state.failAt) throw new Error("storage full");
    state.cache.set(artifactAssetKey(asset), parseArtifactAsset(asset));
  },
}));

const parent: ArtifactParent = { kind: "annotate", id: "set1" };
function snapshot(): ArtifactWhiteboardSnapshot {
  return {
    board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 }, inkPages: { v: 1, pageIds: [0] } },
    pageCount: 2, programs: [], ink: new Map([[0, { v: 2, ops: [] }]]),
  };
}
beforeEach(() => { state.cache.clear(); state.writes = 0; state.failAt = 0; });

describe("whiteboard attachment snapshots", () => {
  it("round trips a saved scene and spanning-page ink without touching the input", async () => {
    const saved = snapshot();
    const pointer = await stageWhiteboardArtifactSnapshot(parent, "board1", saved);
    expect(pointer.ink[0].pageId).toBe(0);
    expect(await loadWhiteboardArtifactSnapshot(parent, pointer)).toMatchObject(saved);
    expect(saved.board.inkPages?.pageIds).toEqual([0]);
    expect(state.writes).toBe(2);
  });

  it("freezes payloads before asynchronous persistence", async () => {
    const saved = snapshot();
    const pending = stageWhiteboardArtifactSnapshot(parent, "board1", saved);
    saved.board.elements.push({ id: "later-edit" });
    saved.ink.clear();
    const pointer = await pending;
    const restored = await loadWhiteboardArtifactSnapshot(parent, pointer);
    expect(restored.board.elements).toEqual([]);
    expect(restored.ink.has(0)).toBe(true);
  });

  it("rejects a missing shard or inline ink before any writes", async () => {
    const saved = snapshot();
    saved.ink.clear();
    await expect(stageWhiteboardArtifactSnapshot(parent, "board1", saved)).rejects.toThrow("ink differ");
    const old = snapshot();
    old.board.inkC = { v: 2, ops: [] };
    await expect(stageWhiteboardArtifactSnapshot(parent, "board1", old)).rejects.toThrow("Invalid attachment");
    expect(state.writes).toBe(0);
  });

  it("does not return a pointer if a later write fails; a retry mints a complete revision", async () => {
    state.failAt = 2;
    await expect(stageWhiteboardArtifactSnapshot(parent, "board1", snapshot())).rejects.toThrow("storage full");
    state.failAt = 0;
    const pointer = await stageWhiteboardArtifactSnapshot(parent, "board1", snapshot());
    expect((await loadWhiteboardArtifactSnapshot(parent, pointer)).pageCount).toBe(2);
    expect(state.cache.size).toBe(3); // An unlinked scene is retained for safe later collection.
  });

  it("refuses incomplete downloads and cannot read another parent's assets", async () => {
    const pointer = await stageWhiteboardArtifactSnapshot(parent, "board1", snapshot());
    await expect(loadWhiteboardArtifactSnapshot({ ...parent, id: "another-set" }, pointer)).rejects.toThrow("unavailable");
    const inkKey = [...state.cache.keys()].find((key) => state.cache.get(key)?.dependency.kind === "ink")!;
    state.cache.delete(inkKey);
    await expect(loadWhiteboardArtifactSnapshot(parent, pointer)).rejects.toThrow("ink is unavailable");
  });
});
