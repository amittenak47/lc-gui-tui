import {
  artifactDependencies, artifactCatalogFields, artifactDependencyKey,
  type ArtifactCatalog,
} from "./padArtifacts";
import { getArtifactAsset, putArtifactAsset, markArtifactAssetTransferred } from "./artifactAssetStore";
import { requireArtifactAssetAck, type ArtifactAsset, type ArtifactAssetLocator } from "./artifactAssets";

export interface ArtifactAssetTransport {
  putArtifactAsset(asset: ArtifactAsset): Promise<ArtifactAsset>;
  getArtifactAsset(locator: ArtifactAssetLocator): Promise<ArtifactAsset | null>;
}

function dependencies(catalog: ArtifactCatalog): ArtifactAssetLocator[] {
  const checked = artifactCatalogFields(catalog, catalog.parent).artifacts!;
  const unique = new Map<string, ArtifactAssetLocator>();
  for (const artifact of checked.artifacts) {
    for (const dependency of artifactDependencies(artifact)) {
      unique.set(artifactDependencyKey(checked.parent, dependency), { parent: checked.parent, dependency });
    }
  }
  return [...unique.values()];
}

/** Cross-check manifests, not merely individual receipts. */
async function requireConsistentAssets(catalog: ArtifactCatalog): Promise<void> {
  for (const artifact of catalog.artifacts) {
    if (artifact.deletedAt !== undefined) continue;
    const content = artifact.content;
    const dependency = artifactDependencies(artifact)[0]!;
    const asset = await getArtifactAsset({ parent: catalog.parent, dependency });
    if (!asset) throw new Error("Attachment content disappeared before parent publication.");
    const payload = JSON.parse(asset.payload);
    if (content.kind === "whiteboard") {
      const expected = new Set(content.ink.map((page) => page.pageId));
      const pages: number[] = payload.board.inkPages?.pageIds ?? [];
      if (expected.size !== pages.length || pages.some((page) => !expected.has(page))) {
        throw new Error("Attachment scene and ink manifests differ; parent sync was not applied.");
      }
    } else if (payload.docType !== content.kind) {
      throw new Error("Attachment document kind does not match its catalog.");
    }
  }
}

/** Do not PUT/acknowledge the parent until every revision was acknowledged. */
export async function uploadArtifactAssets(
  client: ArtifactAssetTransport, catalog: ArtifactCatalog | undefined,
): Promise<void> {
  if (!catalog) return;
  for (const locator of dependencies(catalog)) {
    const asset = await getArtifactAsset(locator);
    if (!asset) throw new Error(`Attachment content is missing (${locator.dependency.id}). Parent sync was not published.`);
    requireArtifactAssetAck(asset, await client.putArtifactAsset(asset));
    await markArtifactAssetTransferred(asset);
    // Keep long catalogs cooperative between assets, not midway through a write.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  await requireConsistentAssets(catalog);
}

/** Stage only: never write the live scratch scene or an unsaved Monaco buffer. */
export async function downloadArtifactAssets(
  client: ArtifactAssetTransport | undefined, catalog: ArtifactCatalog | undefined,
): Promise<void> {
  if (!catalog) return;
  for (const locator of dependencies(catalog)) {
    if (await getArtifactAsset(locator)) continue;
    if (!client) throw new Error("Attachment content must be downloaded before applying this parent.");
    const asset = await client.getArtifactAsset(locator);
    if (!asset) throw new Error(`Attachment revision is unavailable (${locator.dependency.id}). Download is incomplete; retry sync.`);
    if (artifactDependencyKey(asset.parent, asset.dependency) !== artifactDependencyKey(locator.parent, locator.dependency)) {
      throw new Error("Hub returned a different attachment revision; local content was kept.");
    }
    await putArtifactAsset(asset);
    await markArtifactAssetTransferred(asset);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  await requireConsistentAssets(catalog);
}
