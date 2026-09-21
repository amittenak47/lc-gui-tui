/** Self-contained backups; a catalog alone is not a restorable attachment. */
import { artifactCatalogFields, artifactDependencies, artifactDependencyKey, type ArtifactCatalog, type ArtifactParent } from "./padArtifacts";
import { parseArtifactAsset, type ArtifactAsset } from "./artifactAssets";
import { getArtifactAsset, putArtifactAsset } from "./artifactAssetStore";

export interface ArtifactSnapshotBundle {
  v: 1;
  catalog: ArtifactCatalog;
  assets: ArtifactAsset[];
}

export function parseArtifactSnapshotBundle(raw: unknown, parent: ArtifactParent): ArtifactSnapshotBundle | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid attachment backup.");
  const value = raw as Partial<ArtifactSnapshotBundle>;
  const catalog = artifactCatalogFields(value.catalog, parent).artifacts;
  if (value.v !== 1 || !catalog || !Array.isArray(value.assets)) throw new Error("Invalid attachment backup.");
  const assets = value.assets.map(parseArtifactAsset);
  const byKey = new Map<string, ArtifactAsset>();
  for (const asset of assets) {
    if (asset.parent.kind !== parent.kind || asset.parent.id !== parent.id) throw new Error("Attachment backup belongs to another parent.");
    const key = artifactDependencyKey(asset.parent, asset.dependency);
    if (byKey.has(key)) throw new Error("Duplicate attachment revision in backup.");
    byKey.set(key, asset);
  }
  const required = new Set<string>();
  for (const artifact of catalog.artifacts) {
    const dependencies = artifactDependencies(artifact);
    for (const dependency of dependencies) {
      const key = artifactDependencyKey(parent, dependency);
      required.add(key);
      if (!byKey.has(key)) throw new Error("Attachment backup is incomplete; a required revision is missing.");
    }
    if (!dependencies.length) continue;
    const payload = JSON.parse(byKey.get(artifactDependencyKey(parent, dependencies[0]))!.payload);
    if (artifact.content.kind === "whiteboard") {
      const expected = new Set(artifact.content.ink.map((page) => page.pageId));
      const pages: number[] = payload.board.inkPages?.pageIds ?? [];
      if (expected.size !== pages.length || pages.some((page) => !expected.has(page))) throw new Error("Backup scene and ink manifests differ.");
    } else if (payload.docType !== artifact.content.kind) throw new Error("Backup document kind differs from its catalog.");
  }
  if (required.size !== byKey.size) throw new Error("Attachment backup contains unreferenced revisions.");
  return { v: 1, catalog, assets };
}

export async function captureArtifactSnapshot(catalog: ArtifactCatalog | undefined): Promise<ArtifactSnapshotBundle | undefined> {
  if (!catalog) return undefined;
  const checked = artifactCatalogFields(catalog, catalog.parent).artifacts!;
  const assets = new Map<string, ArtifactAsset>();
  for (const artifact of checked.artifacts) {
    for (const dependency of artifactDependencies(artifact)) {
      const key = artifactDependencyKey(checked.parent, dependency);
      if (assets.has(key)) continue;
      const asset = await getArtifactAsset({ parent: checked.parent, dependency });
      if (!asset) throw new Error("Cannot back up attachments: saved content is missing.");
      assets.set(key, asset);
    }
  }
  return parseArtifactSnapshotBundle({ v: 1, catalog: checked, assets: [...assets.values()] }, checked.parent);
}

/** Validate the entire bundle BEFORE any writes; only immutable staging is touched. */
export async function stageArtifactSnapshot(raw: unknown, parent: ArtifactParent): Promise<ArtifactSnapshotBundle | undefined> {
  const bundle = parseArtifactSnapshotBundle(raw, parent);
  if (!bundle) return undefined;
  for (const asset of bundle.assets) {
    await putArtifactAsset(asset);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return bundle;
}
