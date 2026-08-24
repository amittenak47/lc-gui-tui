/**
 * FNV-1a folded into the `bin<hash>-<length>` key.
 *
 * Shared by the sync loop, the cooperative loop, and the worker so the
 * persisted digest cannot drift. Changing this orphans every stored document.
 */
export function hashBytesDigest(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let hash = 0x811c9dc5;
  for (let i = 0; i < view.length; i += 1) {
    hash ^= view[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `bin${hash.toString(36)}-${view.length.toString(36)}`;
}
