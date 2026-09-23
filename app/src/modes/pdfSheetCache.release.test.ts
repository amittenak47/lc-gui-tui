/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { PdfSheetLru, releaseSheet, snapshotSheet } from "./pdfSheetCache";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("releases fallback canvas backing stores without clearing the source", async () => {
  vi.stubGlobal("createImageBitmap", undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({drawImage:vi.fn()} as unknown as CanvasRenderingContext2D);
  const canvas = document.createElement("canvas");
  canvas.width = 800; canvas.height = 1200;
  const sheet = await snapshotSheet(canvas, 2);
  expect(sheet.bitmap).not.toBe(canvas);
  expect(sheet.bitmap.width).toBe(800);
  releaseSheet(sheet);
  expect(sheet.bitmap.width).toBe(0);
  expect(sheet.bitmap.height).toBe(0);
  expect(canvas.width).toBe(800);
});

it("clears every fallback raster when the preview cache is disposed", () => {
  const lru = new PdfSheetLru(5,8);
  const canvases = [document.createElement("canvas"), document.createElement("canvas")];
  canvases.forEach((bitmap,index) => lru.putPreview(index+1,{bitmap,width:300,height:150,pixelScale:0.25}));
  lru.clear();
  expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});
