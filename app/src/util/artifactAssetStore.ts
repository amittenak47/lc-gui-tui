import { withStore, STORE_CONTENT } from "./idb";
import { artifactAssetKey, parseArtifactAsset, type ArtifactAsset, type ArtifactAssetLocator } from "./artifactAssets";

/** Fail visibly if IndexedDB is unavailable; never issue a receipt for a failed write. */
export async function putArtifactAsset(input: ArtifactAsset): Promise<void> {
  const asset = parseArtifactAsset(input);
  const key = artifactAssetKey(asset);
  let conflict: unknown;
  try {
    await withStore(STORE_CONTENT, "readwrite", (store) => {
      const read = store.get(key);
      read.onsuccess = () => {
        try {
          if (read.result !== undefined) {
            const existing = parseArtifactAsset(read.result);
            if (artifactAssetKey(existing) !== key || existing.payload !== asset.payload) {
              throw new Error("Attachment revision already contains different content. Keep both revisions.");
            }
          }
          store.put({ ...read.result, ...asset, lastUsedAt: Date.now() }, key);
        } catch (cause) {
          conflict = cause;
          store.transaction.abort();
        }
      };
    });
  } catch (cause) { throw conflict ?? cause; }
}

export async function getArtifactAsset(locator: ArtifactAssetLocator): Promise<ArtifactAsset | null> {
  const key = artifactAssetKey(locator);
  let raw: unknown;
  await withStore(STORE_CONTENT, "readwrite", store => {
    const request = store.get(key);
    request.onsuccess = () => {
      raw = request.result;
      if (raw !== undefined) store.put({ ...request.result, lastUsedAt: Date.now() }, key);
    };
  });
  if (raw === undefined) return null;
  const asset = parseArtifactAsset(raw);
  if (artifactAssetKey(asset) !== key) throw new Error("Attachment identity does not match its stored revision.");
  return asset;
}

/** Only a verified remote receipt makes a historical cache copy collectable. */
export async function markArtifactAssetTransferred(locator: ArtifactAssetLocator): Promise<void> {
  const key = artifactAssetKey(locator);
  await withStore(STORE_CONTENT, "readwrite", store => {
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result !== undefined) store.put({ ...request.result, transferredAt: Date.now(), lastUsedAt: Date.now() }, key);
    };
  });
}
