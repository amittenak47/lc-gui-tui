import { describe, expect, it } from "vitest";

import { NO_PRESSURE, type InkDrawOp, type InkOp } from "../canvas/rasterInk";
import { conflictPdfFrames } from "../components/conflictDocumentLayout";
import type { PdfPageSize } from "../modes/pdfPageSizeCache";
import { convertPdfInkOps, inferPdfInkLayout } from "./pdfInkLayout";

const sizes: PdfPageSize[] = Array.from({ length: 40 }, (_, i) => ({ pageNumber: i + 1, width: 531, height: 666 }));
const tablet = { w: 642, spread: false };
const desktop = { w: 760, spread: false };
const split = { w: 642, spread: true };

/** A stroke across the middle of `sheet` in `layout`, at fraction `u` across. */
function strokeOn(sheet: number, layout: { w: number; spread: boolean }, u = 0.3): InkDrawOp {
  const frames = conflictPdfFrames(sizes, layout.w, layout.spread).filter((f) => f.pageId === sheet);
  const top = frames[0]!.minY, bottom = frames[frames.length - 1]!.maxY;
  const y = top + (bottom - top) * 0.4;
  return {
    kind: "draw", color: "#d92243", baseWidth: 4, maxFullness: 1, pressureClip: 1, pressureSensitive: false, id: 9, seq: 9,
    points: [{ x: layout.w * u, y, pressure: NO_PRESSURE }, { x: layout.w * (u + 0.1), y: y + 6, pressure: NO_PRESSURE }],
  };
}

const sheetOf = (op: InkOp, layout: { w: number; spread: boolean }) => {
  const y = op.points[0]!.y;
  return conflictPdfFrames(sizes, layout.w, layout.spread).find((f) => y >= f.minY && y <= f.maxY)?.pageId;
};

describe("convertPdfInkOps", () => {
  it("keeps a mark on its sheet when the column width changes, and comes back exactly", () => {
    const op = strokeOn(30, tablet);
    const [moved] = convertPdfInkOps([op], tablet, desktop, sizes);
    expect(sheetOf(moved!, desktop)).toBe(30);
    expect(moved!.points[0]!.x / desktop.w).toBeCloseTo(op.points[0]!.x / tablet.w, 6);
    expect((moved as InkDrawOp).baseWidth).toBeCloseTo(4 * 760 / 642, 6);
    expect(moved!.id).toBe(9);
    const [back] = convertPdfInkOps([moved!], desktop, tablet, sizes);
    expect(back!.points[0]!.x).toBeCloseTo(op.points[0]!.x, 6);
    expect(back!.points[0]!.y).toBeCloseTo(op.points[0]!.y, 6);
  });

  it("places split-sheet ink on the same sheet of a whole-sheet layout at another width", () => {
    const op = strokeOn(12, split, 0.2);
    const moved = convertPdfInkOps([op], split, desktop, sizes);
    expect(moved.length).toBe(1);
    expect(sheetOf(moved[0]!, desktop)).toBe(12);
    const [back] = convertPdfInkOps(moved, desktop, split, sizes);
    expect(back!.points[0]!.y).toBeCloseTo(op.points[0]!.y, 4);
  });

  it("keeps a margin mark off the sheet instead of pinning it to the edge", () => {
    const op = { ...strokeOn(5, tablet), points: [{ x: -30, y: strokeOn(5, tablet).points[0]!.y, pressure: NO_PRESSURE }] };
    const [moved] = convertPdfInkOps([op], tablet, desktop, sizes);
    expect(moved!.points[0]!.x).toBeLessThan(0);
  });
});

describe("inferPdfInkLayout", () => {
  it("names the other device's layout when the hub copy's width is a hint", () => {
    const pages = [3, 17, 33].map((pageId) => ({ pageId, ops: [strokeOn(pageId, tablet)] }));
    expect(inferPdfInkLayout(pages, sizes, [desktop, tablet])).toEqual(tablet);
  });

  it("without a hint, finds a layout that puts every page's ink on its own sheet", () => {
    const pages = [3, 17, 33].map((pageId) => ({ pageId, ops: [strokeOn(pageId, tablet)] }));
    const found = inferPdfInkLayout(pages, sizes, [desktop])!;
    expect(found.spread).toBe(false);
    expect(Math.abs(found.w - 642)).toBeLessThan(24);
    for (const page of pages) {
      const [moved] = convertPdfInkOps(page.ops, found, desktop, sizes);
      expect(sheetOf(moved!, desktop)).toBe(page.pageId);
    }
  });

  it("prefers the hint when it already fits", () => {
    const pages = [8].map((pageId) => ({ pageId, ops: [strokeOn(pageId, desktop)] }));
    expect(inferPdfInkLayout(pages, sizes, [desktop, tablet])).toEqual(desktop);
  });
});
