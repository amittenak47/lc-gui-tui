import { describe, expect, it } from "vitest";

import { destSheetSize, PdfSheetLru, sheetMeetsScale } from "./pdfSheetCache";
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
  it("evicts the page farthest from live C, not the oldest", () => {
    const lru = new PdfSheetLru(3);
    lru.put(10, fakeSheet(1), 10);
    lru.put(11, fakeSheet(1), 11);
    lru.put(12, fakeSheet(1), 12);
    const dropped = lru.put(13, fakeSheet(1), 13);
    expect(dropped.map((item) => item.page)).toEqual([10]);
    expect(lru.has(10)).toBe(false);
    expect(lru.has(13)).toBe(true);
  });

  it("keeps a 2x sheet that still covers 1x after C moves", () => {
    const lru = new PdfSheetLru(25);
    lru.put(5, fakeSheet(2), 5);
    expect(sheetMeetsScale(lru.get(5), 1)).toBe(true);
    expect(pageNeedsDecode(1, 1, 2)).toBe(false);
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
