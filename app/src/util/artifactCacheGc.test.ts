import { expect, it } from "vitest";
import { artifactCachePins } from "./artifactCacheGc";
import { artifactAssetKey } from "./artifactAssets";
import type { ArtifactCatalog } from "./padArtifacts";
const parent = { kind: "problem" as const, id: "d/1" };
const catalog: ArtifactCatalog = { v: 1, parent, revision: "c", artifacts: [{ id: "a", title: "Note", revision: "r",
  createdAt: 1, updatedAt: 1, deletedAt: 1, associations: [], content: { kind: "markdown", documentId: "doc", sourceRevision: "s" } }] };
const key = artifactAssetKey({ parent, dependency: { kind: "document", id: "doc", revision: "s" } });
it("pins deleted/unfiled attachments inside parent, snapshot and queued payloads", () => {
  for (const root of [{ artifacts: catalog }, { artifactBundle: { catalog } }, { body: { artifacts: catalog } }]) {
    expect(artifactCachePins([root]).has(key)).toBe(true);
  }
});
it("pins a draft's original revision after the current catalog changes", () => {
  expect(artifactCachePins([{ parent, item: catalog.artifacts[0], snapshot: {} }]).has(key)).toBe(true);
});
it("fails closed for legacy drafts and damaged catalog roots", () => {
  expect(() => artifactCachePins([{ item: catalog.artifacts[0], snapshot: {} }])).toThrow("legacy");
  expect(() => artifactCachePins([{ ...catalog, revision: "" }])).toThrow();
});
