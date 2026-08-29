/**
 * Full-sheet decoded pixels keyed by PDF page number.
 *
 * Two maps: cheap 0.25 stubs and rest-2 lossless. O(1) getRest / getPreview.
 * Putting rest-2 does not close the stub. Evicting rest-2 keeps the stub so
 * jump-back is not cream. No toBlob on the hot path.
 */

import {
  PDF_PREVIEW_SCALE,
  PDF_REST_SCALE,
  PDF_SESSION_CAP,
} from "../perfPreset";

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

/** Read without touching LRU order — filmstrip thumbs. Prefers rest-2. */
export function peekActiveSheet(page: number): SheetBitmap | null {
  return activeLru?.peek(page) ?? null;
}

export function isRestTarget(targetScale: number): boolean {
  return targetScale + 1e-9 >= PDF_REST_SCALE;
}

export class PdfSheetLru {
  private readonly preview = new Map<number, SheetBitmap>();
  private readonly rest = new Map<number, SheetBitmap>();
  private readonly previewOrder: number[] = [];
  private readonly restOrder: number[] = [];

  constructor(
    readonly restCap: number,
    readonly previewCap = PDF_SESSION_CAP,
  ) {}

  has(page: number): boolean {
    return this.rest.has(page) || this.preview.has(page);
  }

  hasRest(page: number): boolean {
    return this.rest.has(page);
  }

  hasPreview(page: number): boolean {
    return this.preview.has(page);
  }

  /** O(1) lossless. */
  getRest(page: number): SheetBitmap | null {
    const sheet = this.rest.get(page);
    if (!sheet) return null;
    this.touch(this.restOrder, page);
    return sheet;
  }

  getPreview(page: number): SheetBitmap | null {
    const sheet = this.preview.get(page);
    if (!sheet) return null;
    this.touch(this.previewOrder, page);
    return sheet;
  }

  /** Rest-2 if present, else 0.25. */
  get(page: number): SheetBitmap | null {
    return this.getRest(page) ?? this.getPreview(page);
  }

  peekRest(page: number): SheetBitmap | null {
    return this.rest.get(page) ?? null;
  }

  peekPreview(page: number): SheetBitmap | null {
    return this.preview.get(page) ?? null;
  }

  peek(page: number): SheetBitmap | null {
    return this.peekRest(page) ?? this.peekPreview(page);
  }

  /** Best pixelScale in RAM — rest-2 wins. */
  scale(page: number): number {
    return this.peekRest(page)?.pixelScale ?? this.peekPreview(page)?.pixelScale ?? 0;
  }

  /**
   * Decode LOD for the paint queue: which map holds the sheet, not
   * `fit × scale`. Spread-off Kleinberg has fit < 1, so a 0.25 stub is
   * stored as ~0.1px and `scale()` never reaches 0.25 — rest-2 never starts.
   */
  lod(page: number): number {
    if (this.rest.has(page)) return PDF_REST_SCALE;
    if (this.preview.has(page)) return PDF_PREVIEW_SCALE;
    return 0;
  }

  previewScale(page: number): number {
    return this.peekPreview(page)?.pixelScale ?? 0;
  }

  restScale(page: number): number {
    return this.peekRest(page)?.pixelScale ?? 0;
  }

  keys(): number[] {
    return [...new Set([...this.rest.keys(), ...this.preview.keys()])];
  }

  size(): number {
    return this.keys().length;
  }

  restSize(): number {
    return this.rest.size;
  }

  previewSize(): number {
    return this.preview.size;
  }

  /**
   * Store by target: rest-2 does not close an existing 0.25.
   * Returns rest-2 sheets that fell out of the expensive cap.
   */
  put(
    page: number,
    sheet: SheetBitmap,
    focus = 1,
    targetScale = PDF_PREVIEW_SCALE,
  ): DroppedSheet[] {
    if (isRestTarget(targetScale)) return this.putRest(page, sheet, focus);
    this.putPreview(page, sheet, focus);
    return [];
  }

  putPreview(page: number, sheet: SheetBitmap, focus = 1): DroppedSheet[] {
    const prev = this.preview.get(page);
    if (prev && prev !== sheet) closeSheet(prev);
    this.preview.set(page, sheet);
    this.touch(this.previewOrder, page);
    return this.evictPreviewFarthest(focus);
  }

  putRest(page: number, sheet: SheetBitmap, focus = 1): DroppedSheet[] {
    const prev = this.rest.get(page);
    if (prev && prev !== sheet) closeSheet(prev);
    this.rest.set(page, sheet);
    this.touch(this.restOrder, page);
    if (!this.preview.has(page)) {
      const stub = previewStubFromSheet(sheet);
      if (stub) {
        this.preview.set(page, stub);
        this.touch(this.previewOrder, page);
      }
    }
    const dropped = this.evictRestFarthest(focus);
    this.evictPreviewFarthest(focus);
    return dropped;
  }

  evictFarthest(focus: number): DroppedSheet[] {
    const dropped = this.evictRestFarthest(focus);
    this.evictPreviewFarthest(focus);
    return dropped;
  }

  evictRestFarthest(focus: number): DroppedSheet[] {
    return evictFarthestMap(this.rest, this.restOrder, this.restCap, focus);
  }

  evictPreviewFarthest(focus: number): DroppedSheet[] {
    const dropped = evictFarthestMap(
      this.preview,
      this.previewOrder,
      this.previewCap,
      focus,
      (page) => this.rest.has(page),
    );
    for (const item of dropped) closeSheet(item.sheet);
    return [];
  }

  clear(): void {
    for (const sheet of this.preview.values()) closeSheet(sheet);
    for (const sheet of this.rest.values()) closeSheet(sheet);
    this.preview.clear();
    this.rest.clear();
    this.previewOrder.length = 0;
    this.restOrder.length = 0;
  }

  private touch(order: number[], page: number): void {
    const at = order.indexOf(page);
    if (at >= 0) order.splice(at, 1);
    order.push(page);
  }
}

function evictFarthestMap(
  sheets: Map<number, SheetBitmap>,
  order: number[],
  cap: number,
  focus: number,
  skip?: (page: number) => boolean,
): DroppedSheet[] {
  const dropped: DroppedSheet[] = [];
  while (sheets.size > cap && order.length > 0) {
    let far: number | null = null;
    let farDist = -1;
    for (const n of order) {
      if (skip?.(n)) continue;
      const dist = Math.abs(n - focus);
      if (dist > farDist) {
        far = n;
        farDist = dist;
      }
    }
    if (far == null) break;
    order.splice(order.indexOf(far), 1);
    const gone = sheets.get(far);
    sheets.delete(far);
    if (gone) dropped.push({ page: far, sheet: gone });
  }
  return dropped;
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
 * Cheap 0.25 copy from a rest-2 sheet so evicting lossless still has a stub.
 * Returns null when the bitmap is not drawable (tests).
 */
export function previewStubFromSheet(
  sheet: SheetBitmap,
  restScale = PDF_REST_SCALE,
  previewScale = PDF_PREVIEW_SCALE,
): SheetBitmap | null {
  const fit = sheet.pixelScale / Math.max(restScale, 1e-9);
  if (!(fit > 0) || typeof document === "undefined") return null;
  const dest = destSheetSize(sheet, fit, previewScale);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = dest.width;
    canvas.height = dest.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(sheet.bitmap, 0, 0, dest.width, dest.height);
    return {
      bitmap: canvas,
      width: dest.width,
      height: dest.height,
      pixelScale: fit * previewScale,
    };
  } catch {
    return null;
  }
}

/**
 * Identity of a blit source, for {@link blitSheetToSlots}.
 *
 * Sheets are write-once — `snapshotSheet`, `previewStubFromSheet` and
 * `restoreSheetPng` each hand back a freshly created bitmap and nothing draws
 * into one afterwards — so the object is a sound stand-in for its pixels. A
 * source that were mutated in place would need its own invalidation, and does
 * not exist here.
 */
const blitKeys = new WeakMap<object, string>();
let nextBlitKey = 1;

function blitKey(src: CanvasImageSource): string {
  const object = src as unknown as object;
  let key = blitKeys.get(object);
  if (!key) {
    key = `s${nextBlitKey}`;
    nextBlitKey += 1;
    blitKeys.set(object, key);
  }
  return key;
}

/** What a slot canvas already holds, stamped by the blit that put it there. */
const BLIT_STAMP = "pdfBlit";

/**
 * Forget what a slot canvas holds, so the next blit repaints it.
 *
 * Zeroing a canvas already invalidates the stamp — the size check below can
 * never match a 0×0 backing store — so this is belt to that brace, and the
 * place to hang any future path that repaints a slot behind our back.
 */
export function forgetSlotBlit(canvas: HTMLCanvasElement): void {
  delete canvas.dataset[BLIT_STAMP];
}

/**
 * Draw a full-sheet bitmap onto one or two reading slots.
 * Spread splits at the midpoint. dest smaller than src is a 2×→1× demote.
 *
 * A slot already carrying these exact pixels at this exact size is left
 * alone. That is not a micro-optimisation: the paint pump re-blits the whole
 * preview ring at the top of every turn, and assigning `canvas.width` — even
 * the width it already has — is specified to throw away the backing store, so
 * the unconditional version reallocated and re-uploaded a dozen full sheets
 * per turn. Under a path fill that is a dozen textures per skipped page, for
 * eighty pages, on the thread the next `pointerdown` has to be dispatched on.
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
  const key = blitKey(src);
  for (const slot of slots) {
    const canvas = slot.querySelector("canvas");
    if (!canvas) continue;
    const half = slot.dataset.pdfHalf === "right" ? "right" : "left";
    const width = halves ? (half === "right" ? destW - mid : mid) : destW;
    // `destW` rather than `width`: it is what the halved source rect is
    // derived from, so two demotes that happen to give the same half width
    // still read as different blits.
    const stamp = `${key}:${srcW}x${srcH}:${half}:${destW}`;
    if (
      canvas.width === width &&
      canvas.height === destH &&
      canvas.dataset[BLIT_STAMP] === stamp
    ) {
      slot.setAttribute("data-painted", "");
      continue;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    canvas.width = width;
    canvas.height = destH;
    if (halves) {
      const sx = half === "right" ? (srcW * mid) / destW : 0;
      const sw = (srcW * width) / destW;
      ctx.drawImage(src, sx, 0, sw, srcH, 0, 0, width, destH);
    } else {
      ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, destW, destH);
    }
    canvas.dataset[BLIT_STAMP] = stamp;
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
