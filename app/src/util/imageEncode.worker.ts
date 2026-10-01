/**
 * Encoding pictures (PNG, JPEG), off the main thread.
 *
 * Reading a canvas back and encoding it is tens to hundreds of ms of a
 * tablet's main thread: ink tiles saved after each landing, PDF sheets paged
 * out, filmstrip thumbnails. A hand flicking through pages met a frozen
 * frame for each. Here it costs nothing the reader can see.
 */

export interface ImageEncodeRequest {
  id: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  type: string;
  quality?: number;
  /** Answer a data: URL instead of a blob. */
  dataUrl?: boolean;
}

export interface ImageEncodeReply {
  id: number;
  blob: Blob | null;
  url: string | null;
}

self.onmessage = async (event: MessageEvent<ImageEncodeRequest>) => {
  const { id, bitmap, width, height, type, quality, dataUrl } = event.data;
  let blob: Blob | null = null;
  let url: string | null = null;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, width, height);
      blob = await canvas.convertToBlob({ type, quality });
      if (dataUrl) {
        const read = blob;
        url = await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(read);
        });
        blob = null;
      }
    }
  } catch {
    blob = null;
    url = null;
  } finally {
    bitmap.close();
  }
  self.postMessage({ id, blob, url } satisfies ImageEncodeReply);
};
