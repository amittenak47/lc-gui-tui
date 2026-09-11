import { gunzipSync } from "fflate";

import { isAndroidDevice } from "./androidDevice";

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
 *
 * Inflate always has an fflate fallback. Android WebView often advertises
 * `DecompressionStream` and then hangs instead of throwing — the merge window
 * sat on a spinner while the lined paper was already in the DOM underneath.
 * Tablets skip the stream and gunzip with fflate. Elsewhere a stalled stream
 * is abandoned after a beat.
 */

/** gzip's magic number. Present on every member, first thing in the file. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** Give up on `DecompressionStream` and use fflate. Hang, not throw, was the tablet bug. */
const STREAM_STALL_MS = 1200;

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

function inflateGzipWithFflate(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = gunzipSync(bytes);
  return new Uint8Array(out) as Uint8Array<ArrayBuffer>;
}

function inflateGzipViaStream(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer().then((buf) => new Uint8Array(buf) as Uint8Array<ArrayBuffer>);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("gzip stream stalled")), ms);
    promise.then(
      (value) => {
        clearTimeout(id);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(id);
        reject(err);
      },
    );
  });
}

async function inflateGzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  // Android: the stream constructor exists and then never settles. Do not wait.
  if (!isAndroidDevice() && typeof DecompressionStream === "function") {
    try {
      return await withTimeout(inflateGzipViaStream(bytes), STREAM_STALL_MS);
    } catch {
      /* threw or stalled — fflate next */
    }
  }
  try {
    return inflateGzipWithFflate(bytes);
  } catch {
    throw new Error("this device cannot read a compressed annotation archive");
  }
}

/** Inverse of {@link gzipBytes}; sniffs magic so uncompressed archives still open. */
export async function bytesFromMaybeGzip(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!isGzip(bytes)) return bytes;
  return inflateGzip(bytes);
}

/**
 * Read bytes back as text, decompressing when they are gzipped.
 *
 * Sniffed rather than told: the caller usually has a file it did not write and
 * a name it cannot trust.
 */
export async function textFromMaybeGzip(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return new TextDecoder().decode(await bytesFromMaybeGzip(bytes));
}
