import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactCatalog, ArtifactParent } from "./padArtifacts";
import { editArtifactCatalog } from "./artifactCatalogEdits";
import { createArtifact, saveArtifact, readArtifact, type ArtifactSnapshot } from "./artifactRepository";

const state = vi.hoisted(() => ({ catalog: undefined as ArtifactCatalog | undefined, order: [] as string[], fail: false }));
vi.mock("./annotateStore", () => ({ getAnnotateDoc: async () => ({ artifacts: state.catalog }),
  editAnnotateArtifacts: async (id: string, base: string | null, edit: Parameters<typeof editArtifactCatalog>[3]) => {
    state.order.push("publish");
    return state.catalog = editArtifactCatalog(state.catalog, { kind: "annotate", id }, base, edit);
  } }));
vi.mock("./whiteboardStore", () => ({}));
vi.mock("./problemBoardStore", () => ({}));
vi.mock("./artifactDocuments", () => ({ stageOwnedDocumentSnapshot: async (_parent: unknown, documentId: string) => {
  state.order.push("stage"); if (state.fail) throw new Error("disk full");
  return { kind: "markdown", documentId, sourceRevision: crypto.randomUUID() };
}, loadOwnedDocumentSnapshot: async () => ({ source: "saved" }) }));
vi.mock("./artifactWhiteboards", () => ({}));
const parent: ArtifactParent = { kind: "annotate", id: "document" };
const snapshot = { kind: "markdown", value: {} } as ArtifactSnapshot;
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { state.catalog = undefined; state.order = []; state.fail = false;
  vi.stubGlobal("window", { dispatchEvent: vi.fn() }); vi.stubGlobal("CustomEvent", class {}); });
describe("attachment publication", () => {
  it("publishes only after immutable content is staged", async () => {
    const ref = await createArtifact(parent, "Note", [{ kind: "thread", rootId: "question" }], snapshot);
    expect(state.order).toEqual(["stage", "publish"]);
    expect((await readArtifact(ref)).item.associations).toEqual([{ kind: "thread", rootId: "question" }]);
  });
  it("keeps the parent untouched when staging fails", async () => {
    state.fail = true;
    await expect(createArtifact(parent, "Note", [], snapshot)).rejects.toThrow("disk full");
    expect(state.catalog).toBeUndefined(); expect(state.order).toEqual(["stage"]);
  });
  it("rejects stale editor saves before staging, and preserves stable document identity", async () => {
    const ref = await createArtifact(parent, "Note", [], snapshot);
    const before = state.catalog!.artifacts[0]; state.order = [];
    await expect(saveArtifact(ref, "old", "Changed", snapshot)).rejects.toThrow("changed");
    expect(state.order).toEqual([]);
    const saved = await saveArtifact(ref, before.revision, "Changed", snapshot);
    expect(saved.content).toMatchObject({ documentId: (before.content as { documentId: string }).documentId });
    expect(saved.revision).not.toBe(before.revision);
  });
});
