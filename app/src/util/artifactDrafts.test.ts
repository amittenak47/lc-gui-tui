import { beforeEach, describe, expect, it, vi } from "vitest";
import { getArtifactDraft, putArtifactDraft, deleteArtifactDraft, type ArtifactDraft } from "./artifactDrafts";
import type { ArtifactRef } from "./padArtifacts";

const storage = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./contentStore", () => ({
  getContent: async (id: string) => storage.has(id) ? JSON.parse(JSON.stringify(storage.get(id))) : null,
  putContent: async (id: string, value: unknown) => { storage.set(id, JSON.parse(JSON.stringify(value))); },
  deleteContent: async (id: string) => { storage.delete(id); },
}));
const ref: ArtifactRef = { parent: { kind: "whiteboard", id: "parent" }, artifactId: "a", kind: "whiteboard" };
function draft(): ArtifactDraft {
  return { v: 1, title: "Drawing", item: { id: "a", title: "Drawing", revision: "r",
    createdAt: 1, updatedAt: 1, associations: [], content: { kind: "whiteboard", boardId: "w", sceneRevision: "s", ink: [{ pageId: 1, revision: "i" }] } },
    snapshot: { kind: "whiteboard", value: { board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } },
      pageCount: 1, programs: [], ink: new Map([[1, { v: 2, ops: [] }]]) } } };
}
beforeEach(() => storage.clear());
describe("attachment draft recovery", () => {
  it("round-trips packed ink through JSON-only storage", async () => {
    const value = draft();
    await putArtifactDraft(ref, value);
    expect(await getArtifactDraft(ref)).toEqual(value);
  });
  it("does not resurrect an autosave queued before successful-save deletion", async () => {
    const write = putArtifactDraft(ref, draft());
    const remove = deleteArtifactDraft(ref);
    await Promise.all([write, remove]);
    expect(await getArtifactDraft(ref)).toBeNull();
  });
});
