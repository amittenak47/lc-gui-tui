/**
 * What the attachment cache may forget, as pure functions.
 *
 * Kept apart from the store code so the collection can run in a worker:
 * nothing here touches the DOM, `localStorage` or the app's other modules.
 */
import {
  ARTIFACT_ASSET_KEY_PREFIX,
  artifactAssetStoreKey,
  artifactCatalogFields,
  artifactDependencies,
  type PadArtifact,
} from "./padArtifacts";

export const ARTIFACT_CACHE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
/** Most copies one collection deletes. */
export const ARTIFACT_CACHE_DELETE_LIMIT = 64;

export function isArtifactAssetKey(key: IDBValidKey): boolean {
  return String(key).startsWith(ARTIFACT_ASSET_KEY_PREFIX);
}

/** Keep tombstone content too: Restore must still work after the retention window. */
export function artifactCachePins(roots: unknown[]): Set<string> {
  const pins = new Set<string>();
  const visited = new Set<object>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const row = value as Record<string, unknown>;
    if (row.v === 1 && row.parent && Array.isArray(row.artifacts)) {
      const catalog = artifactCatalogFields(row, row.parent as never).artifacts!;
      for (const item of catalog.artifacts) for (const dependency of artifactDependencies({ ...item, deletedAt: undefined })) {
        pins.add(artifactAssetStoreKey(catalog.parent, dependency));
      }
      return;
    }
    if (row.item && row.snapshot) {
      if (!row.parent) throw new Error("Keep legacy attachment drafts until they have been reopened.");
      walk({ v: 1, parent: row.parent, revision: "draft", artifacts: [row.item as PadArtifact] });
    }
    for (const child of Object.values(row)) if (child && typeof child === "object") walk(child);
  };
  for (const root of roots) walk(root);
  return pins;
}

export interface CachedAssetTimes {
  lastUsedAt?: number;
  transferredAt?: number;
}

/**
 * A copy may go only when nothing refers to it, the hub has acknowledged it,
 * and it has been neither used nor sent for the retention window.
 */
export function artifactCopyExpired(key: IDBValidKey, row: CachedAssetTimes | undefined, pins: ReadonlySet<string>, now: number): boolean {
  if (!row || pins.has(String(key))) return false;
  if (!Number.isFinite(row.transferredAt) || !Number.isFinite(row.lastUsedAt)) return false;
  return now - Math.max(row.transferredAt!, row.lastUsedAt!) >= ARTIFACT_CACHE_RETENTION_MS;
}
