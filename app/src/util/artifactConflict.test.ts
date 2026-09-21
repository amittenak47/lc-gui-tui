import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactCatalog, ArtifactParent, PadArtifact } from "./padArtifacts";
import { editArtifactCatalog, requireArtifactCatalogTransition } from "./artifactCatalogEdits";
import { reconcileArtifactConflict } from "./artifactConflict";
const state = vi.hoisted(() => ({ local: undefined as ArtifactCatalog | undefined, fail: false, staged: 0 }));
vi.mock("./artifactRepository", () => ({
  readArtifactCatalog: async () => state.local,
  mutateArtifacts: async (parent: ArtifactParent, base: string | null, edit: Parameters<typeof editArtifactCatalog>[3]) => state.local = editArtifactCatalog(state.local, parent, base, edit),
}));
vi.mock("./artifactAssetSync", () => ({ downloadArtifactAssets: async () => { if (state.fail) throw new Error("missing asset"); } }));
vi.mock("./artifactDocuments", () => ({ loadOwnedDocumentSnapshot: async () => ({}), stageOwnedDocumentSnapshot: async (_: unknown, documentId: string) => {
  state.staged++; return { kind: "markdown", documentId, sourceRevision: "copy" };
} }));
vi.mock("./artifactWhiteboards", () => ({}));
const parent: ArtifactParent = { kind: "annotate", id: "p" };
const item = (revision: string): PadArtifact => ({ id: "a", title: "Note", revision, createdAt: 1, updatedAt: 2,
  content: { kind: "markdown", documentId: "doc", sourceRevision: revision }, associations: [{ kind: "file" }] });
const catalog = (entry: PadArtifact): ArtifactCatalog => ({ v: 1, parent, revision: entry.revision, artifacts: [entry] });
beforeEach(() => { state.local = catalog(item("local")); state.fail = false; state.staged = 0; });
afterEach(() => vi.unstubAllGlobals());
describe("attachment conflict recovery", () => {
  it("keeps both divergent documents and permits publication over either base", async () => {
    const old = state.local!; const remote = catalog(item("remote"));
    const merged = await reconcileArtifactConflict({} as never, parent, remote, "local");
    expect(merged!.artifacts).toHaveLength(2); expect(state.staged).toBe(1);
    expect(merged!.artifacts[1].content).not.toMatchObject({ documentId: "doc" });
    expect(requireArtifactCatalogTransition(old, merged, parent)).toEqual(merged);
    expect(requireArtifactCatalogTransition(remote, merged, parent)).toEqual(merged);
  });
  it("retains a deletion and recovers divergent live content under a new ID", async () => {
    const deleted = catalog({ ...item("remote"), deletedAt: 2 });
    const merged = await reconcileArtifactConflict({} as never, parent, deleted, "local");
    expect(merged!.artifacts[0].deletedAt).toBe(2);
    expect(merged!.artifacts[1].deletedAt).toBeUndefined();
  });
  it("does not mutate the catalog when remote content is unavailable", async () => {
    state.fail = true; const before = state.local;
    await expect(reconcileArtifactConflict({} as never, parent, catalog(item("remote")), "local")).rejects.toThrow("missing asset");
    expect(state.local).toBe(before);
  });
});
