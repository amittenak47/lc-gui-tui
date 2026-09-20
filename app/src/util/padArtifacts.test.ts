import { describe, expect, it } from "vitest";
import {
  artifactCreationAssociations, artifactDependencies, artifactDependencyKey,
  artifactRefKey, missingArtifactDependencies, parseArtifactCatalog,
  requireArtifactCatalogAck, sanitizeArtifactRefs, type ArtifactCatalog, type ArtifactRef,
} from "./padArtifacts";

const parent = { kind: "annotate" as const, id: "annotation-set-1" };
const ref: ArtifactRef = { parent, artifactId: "artifact-1", kind: "whiteboard" };

function catalog(): ArtifactCatalog {
  return {
    v: 1, parent, revision: "catalog-r1",
    artifacts: [{
      id: ref.artifactId, title: "Recursion tree", revision: "artifact-r1",
      createdAt: 1, updatedAt: 2, associations: [{ kind: "thread", rootId: "turn-1" }],
      content: {
        kind: "whiteboard", boardId: "scratch-1", sceneRevision: "scene-r1",
        ink: [{ pageId: 0, revision: "ink-r1" }, { pageId: 2, revision: "ink-r2" }],
      },
    }],
  };
}

describe("artifact references", () => {
  it("deduplicates valid links without trusting previews or file paths", () => {
    expect(sanitizeArtifactRefs([
      { ...ref, png: "preview", path: "C:/outside.md" }, ref, null,
      { ...ref, kind: "executable" }, { ...ref, artifactId: "" },
    ])).toEqual([ref]);
  });

  it("keeps identical IDs in different parents separate", () => {
    const second = { ...ref, parent: { ...parent, id: "annotation-set-2" } };
    expect(sanitizeArtifactRefs([ref, second])).toHaveLength(2);
    expect(artifactRefKey(ref)).not.toBe(artifactRefKey(second));
    expect(artifactRefKey({ ...ref, parent: { kind: "problem", id: "a:b" }, artifactId: "c" }))
      .not.toBe(artifactRefKey({ ...ref, parent: { kind: "problem", id: "a" }, artifactId: "b:c" }));
  });

  it("does not invent links for legacy records", () => {
    for (const value of [undefined, null, {}, [], [{ parent, kind: "code" }]]) {
      expect(sanitizeArtifactRefs(value)).toBeUndefined();
    }
  });
});

describe("artifact creation ownership", () => {
  it("prefers active/attached marks over referenced marks and the thread", () => {
    expect(artifactCreationAssociations({
      activeFootnoteId: "f1", attachedFootnoteIds: ["f1", "f2"],
      referencedFootnoteIds: ["f3"], threadRootId: "t1",
    })).toEqual([{ kind: "footnote", footnoteId: "f1" }, { kind: "footnote", footnoteId: "f2" }]);
  });

  it("shares one artifact among all referenced marks", () => {
    expect(artifactCreationAssociations({ referencedFootnoteIds: ["f1", "f2", "f1"] }))
      .toEqual([{ kind: "footnote", footnoteId: "f1" }, { kind: "footnote", footnoteId: "f2" }]);
  });

  it("falls back to the thread and then the file, ignoring invalid empty IDs", () => {
    expect(artifactCreationAssociations({ attachedFootnoteIds: [""], threadRootId: "t1" }))
      .toEqual([{ kind: "thread", rootId: "t1" }]);
    expect(artifactCreationAssociations({})).toEqual([{ kind: "file" }]);
  });
});

describe("artifact catalog validation", () => {
  it("round-trips current records and accepts absence on older pads", () => {
    expect(parseArtifactCatalog(JSON.parse(JSON.stringify(catalog())))).toEqual(catalog());
    expect(parseArtifactCatalog(undefined)).toBeUndefined();
  });

  it("preserves unfiled and deleted records rather than silently losing them", () => {
    const input = catalog();
    input.artifacts[0]!.associations = [];
    input.artifacts[0]!.deletedAt = 2;
    expect(parseArtifactCatalog(input)).toEqual(input);
    expect(artifactDependencies(input.artifacts[0]!)).toEqual([]);
  });

  it.each(["code", "markdown"] as const)("uses owned document identity for %s", (kind) => {
    const input = catalog();
    input.artifacts[0]!.content = { kind, documentId: "owned-note-1", sourceRevision: "source-r3" };
    expect(parseArtifactCatalog(input)).toEqual(input);
    expect(artifactDependencies(input.artifacts[0]!))
      .toEqual([{ kind: "document", id: "owned-note-1", revision: "source-r3" }]);
  });

  it("rejects malformed/versioned catalogs instead of turning them into empty lists", () => {
    for (const input of [null, {}, { ...catalog(), v: 2 }, { ...catalog(), artifacts: [null] }]) {
      expect(() => parseArtifactCatalog(input)).toThrow("Invalid artifact catalog");
    }
    const input = catalog();
    input.artifacts.push(input.artifacts[0]!);
    expect(() => parseArtifactCatalog(input)).toThrow();
  });

  it("rejects duplicate or invalid shard manifests and timestamps", () => {
    const input = catalog();
    const content = input.artifacts[0]!.content;
    if (content.kind !== "whiteboard") throw new Error("fixture");
    content.ink.push(content.ink[0]!);
    expect(() => parseArtifactCatalog(input)).toThrow();
    content.ink.pop();
    content.ink[0]!.pageId = -1;
    expect(() => parseArtifactCatalog(input)).toThrow();
    content.ink[0]!.pageId = 0;
    input.artifacts[0]!.deletedAt = 3;
    expect(() => parseArtifactCatalog(input)).toThrow();
  });
});

describe("artifact dependency readiness", () => {
  it("requires the scene plus every exact ink revision, including page zero", () => {
    const input = catalog();
    const dependencies = artifactDependencies(input.artifacts[0]!);
    const receipts = new Set([artifactDependencyKey(parent, dependencies[0]!)]);
    expect(missingArtifactDependencies(input, receipts)).toEqual(dependencies.slice(1));
    for (const dependency of dependencies) receipts.add(artifactDependencyKey(parent, dependency));
    expect(missingArtifactDependencies(input, receipts)).toEqual([]);
  });

  it("cannot be satisfied by stale content or another parent's data", () => {
    const input = catalog();
    const dependencies = artifactDependencies(input.artifacts[0]!);
    const receipts = new Set(dependencies.flatMap((dependency) => [
      artifactDependencyKey({ ...parent, id: "another-set" }, dependency),
      artifactDependencyKey(parent, { ...dependency, revision: "stale" }),
    ]));
    expect(missingArtifactDependencies(input, receipts)).toEqual(dependencies);
  });

  it("allows deletion to travel without requiring deleted bytes", () => {
    const input = catalog();
    input.artifacts[0]!.deletedAt = 2;
    expect(missingArtifactDependencies(input, new Set())).toEqual([]);
  });
});

describe("artifact catalog acknowledgements", () => {
  it("accepts a complete catalog echoed back by the hub", () => {
    const input = catalog();
    expect(() => requireArtifactCatalogAck(input, JSON.parse(JSON.stringify(input)), parent)).not.toThrow();
  });

  it("refuses an old hub's success response when it dropped the field", () => {
    expect(() => requireArtifactCatalogAck(catalog(), undefined, parent)).toThrow("not synced");
  });

  it("refuses same-revision truncation and a different parent", () => {
    const sent = catalog();
    expect(() => requireArtifactCatalogAck(sent, { ...sent, artifacts: [] }, parent)).toThrow("not synced");
    expect(() => requireArtifactCatalogAck(sent, { ...sent, parent: { ...parent, id: "other" } }, parent))
      .toThrow("different parent");
  });

  it("does not impose the new acknowledgement contract on legacy pads", () => {
    expect(() => requireArtifactCatalogAck(undefined, undefined, parent)).not.toThrow();
  });

  it("preserves explicit restore ancestry", () => {
    const input = catalog();
    input.artifacts[0]!.restoredFrom = "tombstone-r2";
    expect(parseArtifactCatalog(input)?.artifacts[0]!.restoredFrom).toBe("tombstone-r2");
    expect(() => requireArtifactCatalogAck(input, input, parent)).not.toThrow();
  });
});
