/**
 * Session pagefile for PDF bitmaps.
 *
 * Live canvases stay a small sliding window (GPU RAM). When a sheet leaves
 * that window we compress the *already decoded* pixels (lossless PNG) and
 * drop the GPU backing store. Scroll back inflates that PNG onto the canvas.
 *
 * That is the point for JBIG2 textbooks: decode is sequential arithmetic /
 * Huffman over a shared symbol dictionary, so `page.render` again is a CPU
 * walk of the bitstream, not a cache hit. The pagefile is decoded output,
 * not another trip through the decoder. JPEG was rejected because flattening
 * a photo and wiping the text layer would leave footnote ribbons with
 * nothing to sit on — the spans stay in the DOM while only the bitmap pages
 * out.
 */

import { PDF_SESSION_CAP as SESSION_CAP_DEFAULT } from "../perfPreset";

export { PDF_SESSION_CAP } from "../perfPreset";

export function sessionPathPages(
  from: number,
  to: number,
  lastPage: number,
  cap: number,
): number[] {
  const start = Math.max(1, Math.min(from, lastPage));
  const end = Math.max(1, Math.min(to, lastPage));
  const out: number[] = [];
  if (end >= start) {
    for (let p = end - 1; p >= start && out.length < cap; p -= 1) out.push(p);
  } else {
    for (let p = end + 1; p <= start && out.length < cap; p += 1) out.push(p);
  }
  return out;
}

export type PdfSessionSheet = {
  blob: Blob;
  width: number;
  height: number;
  pixelScale: number;
};

export class PdfPageSession {
  private readonly order: number[] = [];
  private readonly sheets = new Map<number, PdfSessionSheet>();

  constructor(readonly cap = SESSION_CAP_DEFAULT) {}

  has(page: number): boolean {
    return this.sheets.has(page);
  }

  get(page: number): PdfSessionSheet | null {
    const sheet = this.sheets.get(page);
    if (!sheet) return null;
    this.touch(page);
    return sheet;
  }

  size(): number {
    return this.sheets.size;
  }

  clear(): void {
    this.order.length = 0;
    this.sheets.clear();
  }

  delete(page: number): void {
    if (!this.sheets.has(page)) return;
    this.sheets.delete(page);
    const at = this.order.indexOf(page);
    if (at >= 0) this.order.splice(at, 1);
  }

  /**
   * Remember a compressed sheet. Returns pages that fell out of the pagefile
   * and must drop their text layer — the bitmap is gone, so the spans would
   * be a lie.
   */
  put(page: number, sheet: PdfSessionSheet): number[] {
    if (this.sheets.has(page)) {
      this.sheets.set(page, sheet);
      this.touch(page);
      return [];
    }
    const dropped: number[] = [];
    while (this.sheets.size >= this.cap && this.order.length > 0) {
      const oldest = this.order.shift();
      if (oldest == null) break;
      this.sheets.delete(oldest);
      dropped.push(oldest);
    }
    this.sheets.set(page, sheet);
    this.order.push(page);
    return dropped;
  }

  private touch(page: number): void {
    const at = this.order.indexOf(page);
    if (at < 0) return;
    this.order.splice(at, 1);
    this.order.push(page);
  }
}

function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Lossless PNG of an already-decoded full sheet. Does not shrink to CSS size. */
export async function captureSheetPng(
  sheet: { bitmap: CanvasImageSource; width: number; height: number; pixelScale: number },
  shouldAbort?: () => boolean,
): Promise<PdfSessionSheet | null> {
  if (sheet.width < 1 || sheet.height < 1) return null;
  if (shouldAbort?.()) return null;
  await yieldMacrotask();
  if (shouldAbort?.()) return null;
  const off = document.createElement("canvas");
  off.width = sheet.width;
  off.height = sheet.height;
  const ctx = off.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(sheet.bitmap, 0, 0);
  if (shouldAbort?.()) return null;
  await yieldMacrotask();
  if (shouldAbort?.()) return null;
  return new Promise((resolve) => {
    off.toBlob((blob) => {
      if (!blob || shouldAbort?.()) {
        resolve(null);
        return;
      }
      resolve({
        blob,
        width: sheet.width,
        height: sheet.height,
        pixelScale: sheet.pixelScale,
      });
    }, "image/png");
  });
}

export async function restoreSheetPng(
  sheet: PdfSessionSheet,
): Promise<{
  bitmap: ImageBitmap;
  width: number;
  height: number;
  pixelScale: number;
} | null> {
  try {
    const bitmap = await createImageBitmap(sheet.blob);
    return {
      bitmap,
      width: sheet.width,
      height: sheet.height,
      pixelScale: sheet.pixelScale > 0 ? sheet.pixelScale : 1,
    };
  } catch {
    return null;
  }
}

/** @deprecated Slot snapshot at CSS size — throws away rest 2. Not used for LRU eviction. */
export async function captureCanvasPng(
  canvas: HTMLCanvasElement,
  shouldAbort?: () => boolean,
): Promise<PdfSessionSheet | null> {
  if (canvas.width < 1 || canvas.height < 1) return null;
  if (shouldAbort?.()) return null;
  await yieldMacrotask();
  if (shouldAbort?.()) return null;
  const width = Math.max(1, Math.round(canvas.clientWidth || canvas.width));
  const height = Math.max(1, Math.round(canvas.clientHeight || canvas.height));
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  const ctx = off.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, width, height);
  if (shouldAbort?.()) return null;
  await yieldMacrotask();
  if (shouldAbort?.()) return null;
  return new Promise((resolve) => {
    off.toBlob((blob) => {
      if (!blob || shouldAbort?.()) {
        resolve(null);
        return;
      }
      resolve({ blob, width, height, pixelScale: 1 });
    }, "image/png");
  });
}

export async function restoreCanvasPng(
  canvas: HTMLCanvasElement,
  sheet: PdfSessionSheet,
): Promise<boolean> {
  try {
    const bitmap = await createImageBitmap(sheet.blob);
    canvas.width = sheet.width;
    canvas.height = sheet.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return false;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return true;
  } catch {
    return false;
  }
}
