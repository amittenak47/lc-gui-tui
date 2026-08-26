import { describe, expect, it } from "vitest";

import { PDF_PREVIEW_SCALE, PDF_REST_SCALE } from "../perfPreset";
import {
  destSheetSize,
  PdfSheetLru,
  sheetMeetsScale,
} from "./pdfSheetCache";
import { pageNeedsDecode } from "./pdfPaintWindow";

function fakeSheet(pixelScale: number, width = 100, height = 200) {
  return {
    bitmap: {} as HTMLCanvasElement,
    width,
    height,
    pixelScale,
  };
}

describe("PdfSheetLru", () => {
  it("evicts the rest-2 page farthest from live C, not the oldest", () => {
    const lru = new PdfSheetLru(3);
    lru.put(10, fakeSheet(2), 10, PDF_REST_SCALE);
    lru.put(11, fakeSheet(2), 11, PDF_REST_SCALE);
    lru.put(12, fakeSheet(2), 12, PDF_REST_SCALE);
    const dropped = lru.put(13, fakeSheet(2), 13, PDF_REST_SCALE);
    expect(dropped.map((item) => item.page)).toEqual([10]);
    expect(lru.hasRest(10)).toBe(false);
    expect(lru.hasRest(13)).toBe(true);
  });

  it("keeps a 2x sheet that still covers 1x after C moves", () => {
    const lru = new PdfSheetLru(25);
    lru.put(5, fakeSheet(2), 5, PDF_REST_SCALE);
    expect(sheetMeetsScale(lru.get(5), 1)).toBe(true);
    expect(pageNeedsDecode(1, 1, 2)).toBe(false);
  });

  it("put rest-2 does not close an existing 0.25 stub", () => {
    const lru = new PdfSheetLru(8);
    const preview = fakeSheet(0.25, 25, 50);
    lru.put(7, preview, 7, PDF_PREVIEW_SCALE);
    lru.put(7, fakeSheet(2, 200, 400), 7, PDF_REST_SCALE);
    expect(lru.getPreview(7)).toBe(preview);
    expect(lru.getRest(7)?.pixelScale).toBe(2);
    expect(lru.scale(7)).toBe(2);
    expect(lru.lod(7)).toBe(PDF_REST_SCALE);
    expect(lru.lod(8)).toBe(0);
  });

  it("lod is 0.25 after a stub even when stored pixels are fit×0.25", () => {
    const lru = new PdfSheetLru(8);
    lru.put(4, fakeSheet(0.12, 40, 30), 4, PDF_PREVIEW_SCALE);
    expect(lru.scale(4)).toBe(0.12);
    expect(lru.lod(4)).toBe(PDF_PREVIEW_SCALE);
    expect(pageNeedsDecode(0.5, PDF_PREVIEW_SCALE, lru.scale(4))).toBe(true);
    expect(pageNeedsDecode(0.5, PDF_PREVIEW_SCALE, lru.lod(4))).toBe(false);
    expect(pageNeedsDecode(0.5, PDF_REST_SCALE, lru.lod(4))).toBe(true);
  });

  it("evicting rest-2 keeps the 0.25 so jump-back is not cream", () => {
    const lru = new PdfSheetLru(1);
    const preview = fakeSheet(0.25, 25, 50);
    lru.put(1, preview, 1, PDF_PREVIEW_SCALE);
    lru.put(1, fakeSheet(2), 1, PDF_REST_SCALE);
    const dropped = lru.put(9, fakeSheet(2), 9, PDF_REST_SCALE);
    expect(dropped.map((item) => item.page)).toEqual([1]);
    expect(lru.hasRest(1)).toBe(false);
    expect(lru.getPreview(1)).toBe(preview);
  });

  it("getRest is O(1) and does not need the preview map", () => {
    const lru = new PdfSheetLru(4);
    lru.put(3, fakeSheet(2), 3, PDF_REST_SCALE);
    expect(lru.getRest(3)?.pixelScale).toBe(2);
    expect(lru.getRest(4)).toBeNull();
  });
});

describe("destSheetSize", () => {
  it("halves a 2x bitmap when the slot wants 1x", () => {
    const dest = destSheetSize(fakeSheet(2, 200, 400), 1, 1);
    expect(dest).toEqual({ width: 100, height: 200 });
  });

  it("does not invent pixels when the cache is only 1x", () => {
    const dest = destSheetSize(fakeSheet(1, 100, 200), 1, 2);
    expect(dest).toEqual({ width: 100, height: 200 });
  });
});
