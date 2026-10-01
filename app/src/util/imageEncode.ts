/**
 * Encode a picture in a worker — see `imageEncode.worker.ts`.
 *
 * Answers `undefined` where no worker can (no Worker, OffscreenCanvas or
 * createImageBitmap): the caller encodes as it did before. `null` is a
 * failed encode.
 */
import type { ImageEncodeReply, ImageEncodeRequest } from "./imageEncode.worker";

let encoder: Worker | null | undefined;
const waiting = new Map<number, (reply: ImageEncodeReply | null) => void>();
let seq = 0;

function worker(): Worker | null {
  if (encoder !== undefined) return encoder;
  encoder = null;
  if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") {
    return encoder;
  }
  try {
    const w = new Worker(new URL("./imageEncode.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (event: MessageEvent<ImageEncodeReply>) => {
      waiting.get(event.data.id)?.(event.data);
      waiting.delete(event.data.id);
    };
    w.onerror = () => {
      for (const done of waiting.values()) done(null);
      waiting.clear();
      w.terminate();
      encoder = null;
    };
    encoder = w;
  } catch {
    encoder = null;
  }
  return encoder;
}

export interface EncodeOptions {
  /** Size to encode at; the source is scaled to it (on the GPU, before it leaves). */
  width: number;
  height: number;
  type?: string;
  quality?: number;
}

async function encode(source: CanvasImageSource, opts: EncodeOptions, dataUrl: boolean): Promise<ImageEncodeReply | null | undefined> {
  const w = worker();
  if (!w) return undefined;
  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source as ImageBitmapSource, { resizeWidth: width, resizeHeight: height, resizeQuality: "medium" });
  } catch {
    return undefined;
  }
  return new Promise((resolve) => {
    const id = (seq += 1);
    waiting.set(id, resolve);
    w.postMessage(
      { id, bitmap, width, height, type: opts.type ?? "image/png", quality: opts.quality, dataUrl } satisfies ImageEncodeRequest,
      [bitmap],
    );
  });
}

export async function encodeImageBlob(source: CanvasImageSource, opts: EncodeOptions): Promise<Blob | null | undefined> {
  const reply = await encode(source, opts, false);
  return reply === undefined ? undefined : reply?.blob ?? null;
}

export async function encodeImageDataUrl(source: CanvasImageSource, opts: EncodeOptions): Promise<string | null | undefined> {
  const reply = await encode(source, opts, true);
  return reply === undefined ? undefined : reply?.url ?? null;
}
