import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactAssetKey, type ArtifactAsset, type ArtifactAssetLocator } from "./artifactAssets";
import type { ArtifactCatalog } from "./padArtifacts";
import { captureArtifactSnapshot, parseArtifactSnapshotBundle, stageArtifactSnapshot } from "./artifactSnapshot";

const state = vi.hoisted(() => ({ assets: new Map<string, ArtifactAsset>(), writes: 0 }));
vi.mock("./artifactAssetStore", () => ({
  getArtifactAsset: async (locator: ArtifactAssetLocator) => state.assets.get(artifactAssetKey(locator)) ?? null,
  putArtifactAsset: async (asset: ArtifactAsset) => { state.writes++; state.assets.set(artifactAssetKey(asset), asset); },
}));
const parent = { kind: "whiteboard" as const, id: "w1" };
const asset: ArtifactAsset = { parent, dependency: { kind: "scene", id: "scratch1", revision: "s1" },
  payload: JSON.stringify({ v: 1, board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } }, pageCount: 1, programs: [] }) };
const catalog: ArtifactCatalog = { v: 1, parent, revision: "c1", artifacts: [{
  id: "a1", title: "Diagram", revision: "r1", createdAt: 1, updatedAt: 1,
  associations: [{ kind: "file" }], content: { kind: "whiteboard", boardId: "scratch1", sceneRevision: "s1", ink: [] },
}] };
const bundle = () => ({ v: 1 as const, catalog: structuredClone(catalog), assets: [structuredClone(asset)] });
beforeEach(() => { state.assets.clear(); state.writes = 0; });

describe("self-contained attachment backups", () => {
  it("captures exact revisions and stages them on a device with an empty cache", async () => {
    state.assets.set(artifactAssetKey(asset), asset);
    const captured = await captureArtifactSnapshot(catalog);
    state.assets.clear();
    expect(await stageArtifactSnapshot(captured, parent)).toEqual(bundle());
    expect(state.assets.get(artifactAssetKey(asset))).toEqual(asset);
  });
  it("rejects missing, extra and duplicate content before any staging write", async () => {
    for (const assets of [[], [asset, asset], [asset, { ...asset, dependency: { ...asset.dependency, revision: "extra" } }]]) {
      await expect(stageArtifactSnapshot({ ...bundle(), assets }, parent)).rejects.toThrow();
      expect(state.writes).toBe(0);
    }
    await expect(captureArtifactSnapshot(catalog)).rejects.toThrow("missing");
  });
  it("rejects foreign ownership and inconsistent scene manifests", () => {
    expect(() => parseArtifactSnapshotBundle(bundle(), { ...parent, id: "other" })).toThrow();
    const mismatched = bundle();
    const payload = JSON.parse(mismatched.assets[0].payload);
    payload.board.inkPages = { v: 1, pageIds: [0] };
    mismatched.assets[0].payload = JSON.stringify(payload);
    expect(() => parseArtifactSnapshotBundle(mismatched, parent)).toThrow("manifests differ");
  });
  it("retains deletion records without requiring deleted content and accepts legacy absence", () => {
    const deleted = bundle();
    deleted.catalog.artifacts[0].deletedAt = 1;
    deleted.assets = [];
    expect(parseArtifactSnapshotBundle(deleted, parent)).toEqual(deleted);
    expect(parseArtifactSnapshotBundle(undefined, parent)).toBeUndefined();
  });
});
