import { parseArtifactCatalog, type ArtifactCatalog } from "./padArtifacts";
import { canonicalJson } from "./syncContent";

export const ARTIFACT_CATALOG_ROW_ID = "@artifact-catalog";

/** Catalog revision/order alone is not a change to an attachment. */
export function conflictArtifactCatalogs(local: unknown, server: unknown) {
  const a = parseArtifactCatalog(local), b = parseArtifactCatalog(server);
  const entries = (catalog: ArtifactCatalog | undefined) =>
    canonicalJson([...(catalog?.artifacts ?? [])].sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { local: a, server: b, same: entries(a) === entries(b) };
}

export function conflictArtifactCatalogLabel(catalog: ArtifactCatalog | undefined): string {
  const entries = catalog?.artifacts ?? [];
  return entries.length
    ? `Attachments: ${entries.map(item => `${item.title}${item.deletedAt !== undefined ? " (trashed)" : ""}`).join(", ")}`
    : "No attachments";
}
