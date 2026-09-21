import { describe, expect, it } from "vitest";
import { ArtifactEditConflict, editArtifactCatalog, requireArtifactCatalogTransition, type ArtifactCatalogEdit } from "./artifactCatalogEdits";
import type { ArtifactParent } from "./padArtifacts";

const parent: ArtifactParent = { kind: "annotate", id: "a1" };
const create: ArtifactCatalogEdit = { type: "create", id: "file1", title: "Note.md",
  associations: [{ kind: "footnote", footnoteId: "f1" }, { kind: "thread", rootId: "t1" }],
  content: { kind: "markdown", documentId: "doc1", sourceRevision: "s1" } };
const initial = () => editArtifactCatalog(undefined, parent, null, create, 1);

describe("revision-checked attachment edits", () => {
  it("creates independent metadata without mutating input and updates against the known base", () => {
    const before = initial();
    const next = editArtifactCatalog(before, parent, before.revision, {
      type: "update", id: "file1", expectedRevision: before.artifacts[0].revision, patch: { title: "Renamed.md" },
    }, 0); // Wall clock rollback cannot move the edited record backwards.
    expect(next.artifacts[0]).toMatchObject({ title: "Renamed.md", createdAt: 1, updatedAt: 2 });
    expect(before.artifacts[0].title).toBe("Note.md");
    expect(next.revision).not.toBe(before.revision);
  });

  it("rejects a stale catalog, stale artifact and reused identity", () => {
    const before = initial();
    expect(() => editArtifactCatalog(before, parent, null, create)).toThrow(ArtifactEditConflict);
    expect(() => editArtifactCatalog(before, parent, before.revision, create)).toThrow(ArtifactEditConflict);
    expect(() => editArtifactCatalog(before, parent, before.revision, { type: "delete", id: "file1", expectedRevision: "old" }))
      .toThrow(ArtifactEditConflict);
  });

  it("detaches only the requested association and keeps an unfiled artifact recoverable", () => {
    const before = initial();
    const first = editArtifactCatalog(before, parent, before.revision, { type: "detach", association: { kind: "footnote", footnoteId: "f1" } }, 2);
    expect(first.artifacts[0].associations).toEqual([{ kind: "thread", rootId: "t1" }]);
    const unfiled = editArtifactCatalog(first, parent, first.revision, { type: "detach", association: { kind: "thread", rootId: "t1" } }, 3);
    expect(unfiled.artifacts[0].associations).toEqual([]);
    expect(unfiled.artifacts[0].deletedAt).toBeUndefined();
    expect(unfiled.artifacts[0].content).toEqual(before.artifacts[0].content);
  });

  it("retains tombstones and requires explicit restoration naming the deletion revision", () => {
    const before = initial();
    const deleted = editArtifactCatalog(before, parent, before.revision, { type: "delete", id: "file1", expectedRevision: before.artifacts[0].revision }, 2);
    expect(deleted.artifacts[0].deletedAt).toBe(2);
    expect(() => requireArtifactCatalogTransition(deleted, before, parent)).toThrow("Restoring");
    expect(() => editArtifactCatalog(deleted, parent, deleted.revision, { type: "update", id: "file1", expectedRevision: deleted.artifacts[0].revision, patch: { title: "Lost" } }))
      .toThrow("live/deleted");
    const restored = editArtifactCatalog(deleted, parent, deleted.revision, { type: "restore", id: "file1", expectedRevision: deleted.artifacts[0].revision }, 3);
    expect(restored.artifacts[0].deletedAt).toBeUndefined();
    expect(restored.artifacts[0].restoredFrom).toBe(deleted.artifacts[0].revision);
  });

  it("rejects dropped records, changed identities, and revision reuse", () => {
    const before = initial();
    expect(() => requireArtifactCatalogTransition(before, { ...before, revision: "new", artifacts: [] }, parent)).toThrow("deletion records");
    const changed = structuredClone(before);
    changed.artifacts[0].title = "Changed";
    expect(() => requireArtifactCatalogTransition(before, changed, parent)).toThrow("catalog revision");
    changed.revision = "new";
    expect(() => requireArtifactCatalogTransition(before, changed, parent)).toThrow("revision was reused");
    expect(() => editArtifactCatalog(before, parent, before.revision, { type: "update", id: "file1", expectedRevision: before.artifacts[0].revision,
      patch: { content: { kind: "markdown", documentId: "different", sourceRevision: "s2" } } })).toThrow("identity");
  });

  it("preserves omitted catalogs and does not mint revisions for irrelevant detaches", () => {
    const before = initial();
    expect(requireArtifactCatalogTransition(before, undefined, parent)).toEqual(before);
    expect(editArtifactCatalog(before, parent, before.revision, { type: "detach", association: { kind: "file" } })).toEqual(before);
  });
});
