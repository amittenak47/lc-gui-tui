import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactAssetKey, parseArtifactAsset, type ArtifactAsset, type ArtifactAssetLocator } from "./artifactAssets";
import { loadOwnedDocumentSnapshot, stageOwnedDocumentSnapshot, type ArtifactDocumentSnapshot } from "./artifactDocuments";
import type { ArtifactParent } from "./padArtifacts";

const state = vi.hoisted(() => ({ cache: new Map<string, ArtifactAsset>(), fail: false }));
vi.mock("./artifactAssetStore", () => ({
  getArtifactAsset: async (locator: ArtifactAssetLocator) => state.cache.get(artifactAssetKey(locator)) ?? null,
  putArtifactAsset: async (asset: ArtifactAsset) => {
    if (state.fail) throw new Error("storage full");
    state.cache.set(artifactAssetKey(asset), parseArtifactAsset(asset));
  },
}));
const parent: ArtifactParent = { kind: "problem", id: "leetcode/1" };
function snapshot(docType: "code" | "markdown" = "code"): ArtifactDocumentSnapshot {
  return {
    owned: true, docType, name: docType === "code" ? "solution.py" : "Explanation.md",
    source: docType === "code" ? "print(1)\n" : "# Explanation\n",
    board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 }, inkPages: { v: 1, pageIds: [0] } },
    footnotes: [], agent: [{ role: "user", text: "Explain this" }],
    ink: new Map([[0, { v: 2, ops: [] }]]),
  };
}
beforeEach(() => { state.cache.clear(); state.fail = false; });

describe("owned document attachment snapshots", () => {
  it("preserves source capture provenance and rejects oversized excerpts", async () => {
    const saved = snapshot("markdown");
    saved.sourceReference = { v: 1, parent: { kind: "annotate", id: "library-source" }, revision: "r", label: "Book",
      locator: "Page 2", capturedAt: 1, truncated: false, image: "data:image/png;base64,YQ==" };
    const pointer = await stageOwnedDocumentSnapshot(parent, "capture", saved);
    expect(await loadOwnedDocumentSnapshot(parent, pointer)).toEqual(saved);
    saved.source = "x".repeat(12001);
    await expect(stageOwnedDocumentSnapshot(parent, "capture", saved)).rejects.toThrow();
  });
  it.each(["code", "markdown"] as const)("round trips %s source and annotations together", async (kind) => {
    const saved = snapshot(kind);
    const pointer = await stageOwnedDocumentSnapshot(parent, "owned-1", saved);
    expect(pointer.kind).toBe(kind);
    expect(await loadOwnedDocumentSnapshot(parent, pointer)).toEqual(saved);
  });

  it("freezes the snapshot before storage and mints independent edit revisions", async () => {
    const saved = snapshot();
    const pending = stageOwnedDocumentSnapshot(parent, "owned-1", saved);
    saved.source = "print(2)";
    saved.agent.length = 0;
    const first = await pending;
    const second = await stageOwnedDocumentSnapshot(parent, "owned-1", saved);
    expect(first.sourceRevision).not.toBe(second.sourceRevision);
    expect((await loadOwnedDocumentSnapshot(parent, first)).source).toBe("print(1)\n");
    expect((await loadOwnedDocumentSnapshot(parent, first)).agent).toHaveLength(1);
    expect((await loadOwnedDocumentSnapshot(parent, second)).source).toBe("print(2)");
  });

  it("rejects imported documents and incomplete ink without writing", async () => {
    const imported = { ...snapshot(), owned: false };
    // Exercise the runtime boundary, not merely the compile-time ownership flag.
    await expect(stageOwnedDocumentSnapshot(parent, "owned-1", imported as unknown as ArtifactDocumentSnapshot)).rejects.toThrow("Invalid attachment");
    const missing = snapshot();
    missing.ink.clear();
    await expect(stageOwnedDocumentSnapshot(parent, "owned-1", missing)).rejects.toThrow("Invalid attachment");
    expect(state.cache.size).toBe(0);
  });

  it("returns no pointer on failed storage and refuses wrong-parent/wrong-kind opens", async () => {
    state.fail = true;
    await expect(stageOwnedDocumentSnapshot(parent, "owned-1", snapshot())).rejects.toThrow("storage full");
    state.fail = false;
    const pointer = await stageOwnedDocumentSnapshot(parent, "owned-1", snapshot());
    await expect(loadOwnedDocumentSnapshot({ ...parent, id: "leetcode/2" }, pointer)).rejects.toThrow("unavailable");
    await expect(loadOwnedDocumentSnapshot(parent, { ...pointer, kind: "markdown" })).rejects.toThrow("kind does not match");
  });
});
