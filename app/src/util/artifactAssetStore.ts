import { run, withStore, STORE_CONTENT } from "./idb";
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
          } else store.put(asset, key);
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
  const raw = await run<unknown>(STORE_CONTENT, "readonly", (store) => store.get(key));
  if (raw === undefined) return null;
  const asset = parseArtifactAsset(raw);
  if (artifactAssetKey(asset) !== key) throw new Error("Attachment identity does not match its stored revision.");
  return asset;
}
