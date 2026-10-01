import { describe, expect, it } from "vitest";
import { artifactCachePins } from "./artifactCacheGc";
import { artifactCopyExpired } from "./artifactCachePins";
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

describe("which cached copies may go", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const key = "artifact-asset:v1:x";
  it("keeps anything referenced, unsent or recently used", () => {
    const old = { transferredAt: now - 10 * DAY, lastUsedAt: now - 10 * DAY };
    expect(artifactCopyExpired(key, old, new Set([key]), now)).toBe(false);
    expect(artifactCopyExpired(key, { lastUsedAt: now - 10 * DAY }, new Set(), now)).toBe(false);
    expect(artifactCopyExpired(key, { ...old, lastUsedAt: now - DAY }, new Set(), now)).toBe(false);
    expect(artifactCopyExpired(key, undefined, new Set(), now)).toBe(false);
  });
  it("lets go of an old, acknowledged, unreferenced copy", () => {
    expect(artifactCopyExpired(key, { transferredAt: now - 4 * DAY, lastUsedAt: now - 5 * DAY }, new Set(), now)).toBe(true);
  });
});
