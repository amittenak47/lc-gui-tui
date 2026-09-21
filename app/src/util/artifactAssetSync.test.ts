import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactAssetKey, parseArtifactAsset, type ArtifactAsset } from "./artifactAssets";
import type { ArtifactCatalog } from "./padArtifacts";
import { downloadArtifactAssets, uploadArtifactAssets, type ArtifactAssetTransport } from "./artifactAssetSync";

const cache = vi.hoisted(() => new Map<string, ArtifactAsset>());
vi.mock("./artifactAssetStore", () => ({
  markArtifactAssetTransferred: vi.fn(async () => {}),
  getArtifactAsset: async (locator: ArtifactAsset) => cache.get(artifactAssetKey(locator)) ?? null,
  putArtifactAsset: async (asset: ArtifactAsset) => { cache.set(artifactAssetKey(asset), parseArtifactAsset(asset)); },
}));
const scene: ArtifactAsset = {
  parent: { kind: "annotate", id: "a1" }, dependency: { kind: "scene", id: "b1", revision: "s1" },
  payload: JSON.stringify({ v: 1, board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } }, pageCount: 1, programs: [] }),
};
const catalog: ArtifactCatalog = {
  v: 1, parent: scene.parent, revision: "c1", artifacts: [{
    id: "artifact1", title: "Diagram", revision: "r1", createdAt: 1, updatedAt: 1,
    associations: [{ kind: "file" }], content: { kind: "whiteboard", boardId: "b1", sceneRevision: "s1", ink: [] },
  }],
};
function transport(): ArtifactAssetTransport {
  return { putArtifactAsset: vi.fn(async (asset) => asset), getArtifactAsset: vi.fn(async () => scene) };
}
beforeEach(() => cache.clear());

describe("attachment dependency transfer", () => {
  it("blocks upload when content is missing instead of publishing only pointers", async () => {
    const client = transport();
    await expect(uploadArtifactAssets(client, catalog)).rejects.toThrow("missing");
    expect(client.putArtifactAsset).not.toHaveBeenCalled();
  });

  it("requires exact acknowledgements", async () => {
    cache.set(artifactAssetKey(scene), scene);
    const client = transport();
    await uploadArtifactAssets(client, catalog);
    expect(client.putArtifactAsset).toHaveBeenCalledWith(scene);
    client.putArtifactAsset = vi.fn(async (asset) => ({ ...asset, payload: `${asset.payload} ` }));
    await expect(uploadArtifactAssets(client, catalog)).rejects.toThrow("not acknowledged");
  });

  it("downloads to staging and reuses validated cached revisions on retry", async () => {
    const client = transport();
    await downloadArtifactAssets(client, catalog);
    await downloadArtifactAssets(client, catalog);
    expect(client.getArtifactAsset).toHaveBeenCalledTimes(1);
    expect(cache.get(artifactAssetKey(scene))).toEqual(scene);
  });

  it("does not accept missing or mismatched remote revisions", async () => {
    const client = transport();
    client.getArtifactAsset = vi.fn(async () => null);
    await expect(downloadArtifactAssets(client, catalog)).rejects.toThrow("incomplete");
    client.getArtifactAsset = vi.fn(async () => ({ ...scene, parent: { ...scene.parent, id: "other" } }));
    await expect(downloadArtifactAssets(client, catalog)).rejects.toThrow("different attachment");
    expect(cache.size).toBe(0);
  });

  it("refuses a scene whose ink manifest disagrees with the catalog", async () => {
    const payload = JSON.parse(scene.payload);
    payload.board.inkPages = { v: 1, pageIds: [1] };
    cache.set(artifactAssetKey(scene), { ...scene, payload: JSON.stringify(payload) });
    await expect(downloadArtifactAssets(undefined, catalog)).rejects.toThrow("manifests differ");
  });
});
