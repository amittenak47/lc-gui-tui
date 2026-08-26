/**
 * Full-sheet decoded pixels keyed by PDF page number.
 *
 * Survives Spread remounts and 2× demote. Scroll reuses these; only the
 * new edge of the outer ring that is missing gets pdf.js. No toBlob.
 */

export interface SheetBitmap {
  bitmap: ImageBitmap | HTMLCanvasElement;
  width: number;
  height: number;
  pixelScale: number;
}

export type DroppedSheet = { page: number; sheet: SheetBitmap };

let activeLru: PdfSheetLru | null = null;

export function setActiveSheetLru(lru: PdfSheetLru | null): void {
  activeLru = lru;
}

/** Read without touching LRU order — filmstrip thumbs. */
export function peekActiveSheet(page: number): SheetBitmap | null {
  return activeLru?.peek(page) ?? null;
}

export class PdfSheetLru {
  private readonly order: number[] = [];
  private readonly sheets = new Map<number, SheetBitmap>();

  constructor(readonly cap: number) {}

  has(page: number): boolean {
    return this.sheets.has(page);
  }

  get(page: number): SheetBitmap | null {
    const sheet = this.sheets.get(page);
    if (!sheet) return null;
    this.touch(page);
    return sheet;
  }

  peek(page: number): SheetBitmap | null {
    return this.sheets.get(page) ?? null;
  }

  scale(page: number): number {
    return this.sheets.get(page)?.pixelScale ?? 0;
  }

  keys(): number[] {
    return [...this.sheets.keys()];
  }

  size(): number {
    return this.sheets.size;
  }

  put(page: number, sheet: SheetBitmap, focus = 1): DroppedSheet[] {
    const prev = this.sheets.get(page);
    if (prev && prev !== sheet) closeSheet(prev);
    this.sheets.set(page, sheet);
    this.touch(page);
    return this.evictFarthest(focus);
  }

  evictFarthest(focus: number): DroppedSheet[] {
    const dropped: DroppedSheet[] = [];
    while (this.sheets.size > this.cap && this.order.length > 0) {
      let far = this.order[0]!;
      let farDist = Math.abs(far - focus);
      for (const n of this.order) {
        const dist = Math.abs(n - focus);
        if (dist > farDist) {
          far = n;
          farDist = dist;
        }
      }
      this.order.splice(this.order.indexOf(far), 1);
      const gone = this.sheets.get(far);
      this.sheets.delete(far);
      if (gone) dropped.push({ page: far, sheet: gone });
    }
    return dropped;
  }

  clear(): void {
    for (const sheet of this.sheets.values()) closeSheet(sheet);
    this.sheets.clear();
    this.order.length = 0;
  }

  private touch(page: number): void {
    const at = this.order.indexOf(page);
    if (at >= 0) this.order.splice(at, 1);
    this.order.push(page);
  }
}

export function sheetMeetsScale(sheet: SheetBitmap | null, needed: number): boolean {
  if (!sheet || !(needed > 0)) return false;
  return sheet.pixelScale + 1e-6 >= needed;
}

export function releaseSheet(sheet: SheetBitmap): void {
  closeSheet(sheet);
}

function closeSheet(sheet: SheetBitmap): void {
  if (typeof ImageBitmap !== "undefined" && sheet.bitmap instanceof ImageBitmap) {
    try {
      sheet.bitmap.close();
    } catch {
      /* already closed */
    }
  }
}

/** Slot pixel size for a cached sheet at the target paint scale. */
export function destSheetSize(
  sheet: SheetBitmap,
  fit: number,
  targetScale: number,
): { width: number; height: number } {
  const needed = fit * targetScale;
  const ratio = Math.min(1, needed / Math.max(sheet.pixelScale, 1e-9));
  return {
    width: Math.max(1, Math.round(sheet.width * ratio)),
    height: Math.max(1, Math.round(sheet.height * ratio)),
  };
}

/**
 * Draw a full-sheet bitmap onto one or two reading slots.
 * Spread splits at the midpoint. dest smaller than src is a 2×→1× demote.
 */
export function blitSheetToSlots(
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  slots: HTMLElement[],
  destW: number,
  destH: number,
): void {
  const halves = slots.length > 1;
  const mid = Math.max(1, Math.round(destW / 2));
  for (const slot of slots) {
    const canvas = slot.querySelector("canvas");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) continue;
    const half = slot.dataset.pdfHalf === "right" ? "right" : "left";
    if (halves) {
      canvas.width = half === "right" ? destW - mid : mid;
      canvas.height = destH;
      const sx = half === "right" ? (srcW * mid) / destW : 0;
      const sw = (srcW * canvas.width) / destW;
      ctx.drawImage(src, sx, 0, sw, srcH, 0, 0, canvas.width, destH);
    } else {
      canvas.width = destW;
      canvas.height = destH;
      ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, destW, destH);
    }
    slot.setAttribute("data-painted", "");
  }
}

export async function snapshotSheet(
  src: HTMLCanvasElement,
  pixelScale: number,
): Promise<SheetBitmap> {
  let bitmap: ImageBitmap | HTMLCanvasElement = src;
  try {
    bitmap = await createImageBitmap(src);
  } catch {
    const copy = document.createElement("canvas");
    copy.width = src.width;
    copy.height = src.height;
    copy.getContext("2d")?.drawImage(src, 0, 0);
    bitmap = copy;
  }
  return {
    bitmap,
    width: src.width,
    height: src.height,
    pixelScale,
  };
}
