import { openDb, STORE_CONTENT, STORE_PROBLEM_BOARDS, STORE_SNAPSHOTS, STORE_SYNC_QUEUE } from "./idb";
import { contentSpillOnly } from "./contentStore";
import { artifactAssetKey } from "./artifactAssets";
import { artifactCatalogFields, artifactDependencies, type PadArtifact } from "./padArtifacts";

export const ARTIFACT_CACHE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

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
        pins.add(artifactAssetKey({ parent: catalog.parent, dependency }));
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

/** One transaction sees all roots and deletes only old, acknowledged cache copies. */
export async function collectArtifactCache(now = Date.now(), pending: unknown[] = []): Promise<number> {
  if (contentSpillOnly()) return 0;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const names = [STORE_CONTENT, STORE_PROBLEM_BOARDS, STORE_SNAPSHOTS, STORE_SYNC_QUEUE];
    const tx = db.transaction(names, "readwrite");
    const roots: unknown[] = [...pending];
    const assets: Array<{ key: IDBValidKey; row: { lastUsedAt?: number; transferredAt?: number } }> = [];
    let remaining = names.length, removed = 0;
    for (const name of names) {
      const request = tx.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          if (name === STORE_CONTENT && String(cursor.key).startsWith("artifact-asset:v1:")) assets.push({ key: cursor.key, row: cursor.value });
          else roots.push(cursor.value);
          cursor.continue();
        } else if (--remaining === 0) {
          try {
            const pins = artifactCachePins(roots);
            for (const { key, row } of assets) {
              if (removed >= 64) break;
              if (!pins.has(String(key)) && Number.isFinite(row.transferredAt) && Number.isFinite(row.lastUsedAt) &&
                  now - Math.max(row.transferredAt!, row.lastUsedAt!) >= ARTIFACT_CACHE_RETENTION_MS) {
                tx.objectStore(STORE_CONTENT).delete(key);
                removed++;
              }
            }
          } catch { /* Unknown roots/drafts: retain everything. */ }
        }
      };
    }
    tx.oncomplete = () => resolve(removed);
    tx.onabort = () => reject(tx.error ?? new Error("Attachment cache cleanup failed."));
    tx.onerror = () => {};
  });
}
