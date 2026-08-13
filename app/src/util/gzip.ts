/**
 * gzip, for the payloads that are still strings.
 *
 * Two are left after board content moved to IndexedDB: the sidecar file a
 * writer exports to keep their annotations outside one browser, and the board
 * the daemon writes to disk. Both are JSON, and JSON of handwriting is
 * enormously redundant — the same six field names repeated once per point, tens
 * of thousands of times. An annotated page measures 78 KB as JSON and about
 * 2 KB gzipped.
 *
 * `CompressionStream` is in every browser this ships to and absent in Node,
 * older WebViews, and any environment behind a polyfill that did not include
 * it. So compression is optional on the way out and *detected* on the way in:
 * a sidecar is recognised by its first two bytes rather than by its file name,
 * which means one that was renamed, or written by a build without
 * `CompressionStream`, still opens.
 */

/** gzip's magic number. Present on every member, first thing in the file. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

export function isGzip(bytes: Uint8Array<ArrayBuffer>): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

export function canGzip(): boolean {
  return typeof CompressionStream === "function";
}

/** Compress a string, or hand back its UTF-8 bytes where gzip is unavailable. */
export async function gzipText(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new TextEncoder().encode(text);
  if (!canGzip()) return raw;
  try {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    // A stream implementation that exists but does not work is worse than one
    // that does not exist — the uncompressed file still opens everywhere.
    return raw;
  }
}

/** gzip typed bytes (archive shards), or return them unchanged. */
export async function gzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (!canGzip()) return bytes;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return bytes;
  }
}

/** Inverse of {@link gzipBytes}; sniffs magic so uncompressed archives still open. */
export async function bytesFromMaybeGzip(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!isGzip(bytes)) return bytes;
  if (typeof DecompressionStream !== "function") {
    throw new Error("this device cannot read a compressed annotation archive");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read bytes back as text, decompressing when they are gzipped.
 *
 * Sniffed rather than told: the caller usually has a file it did not write and
 * a name it cannot trust.
 */
export async function textFromMaybeGzip(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!isGzip(bytes)) return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream !== "function") {
    throw new Error("this device cannot read a compressed annotation file");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}
