import { describe, expect, it } from "vitest";
import { conflictDocumentWidth, conflictPdfFrames, inkSpreadOf } from "./conflictDocumentLayout";
import { remapInkBetweenPdfLayouts } from "../modes/pdfInkSpread";
import { conflictInkPlacement } from "./conflictInkLayout";

describe("replica annotation layout", () => {
  it("uses each frozen document's saved width, with a fallback for old snapshots", () => {
    const pad = (width: number) => ({board: {elements: [{width, customData: {lcMdInkFrame: true}}]}});
    expect(conflictDocumentWidth(pad(1100), 1100)).toBe(1100);
    expect(conflictDocumentWidth(pad(780), 1100)).toBe(780);
    expect(conflictDocumentWidth(pad(NaN), 1100)).toBe(1100);
    expect(conflictDocumentWidth({board: null}, 1100)).toBe(1100);
  });

  it("keeps late-page ink on the same passage across widths, mixed page sizes and fixed gaps", () => {
    const pages = Array.from({length: 100}, (_, i) => ({pageNumber: i + 1, width: i % 3 ? 600 : 810, height: 800}));
    for (const width of [780, 1100]) {
      const authored = conflictPdfFrames(pages, width);
      for (const paneWidth of [300, 947]) {
        const preview = conflictPdfFrames(pages, paneWidth);
        for (const index of [0, 49, 99]) {
          const source = authored[index], target = preview[index];
          const placement = conflictInkPlacement({page: index + 1, left: 0, top: target.minY, width: paneWidth, height: target.maxY - target.minY}, source, width);
          expect((source.minY + 100 - placement.originY) * placement.scale).toBeCloseTo(100 * paneWidth / width);
          expect(placement.originY).toBe(18 + pages.slice(0, index).reduce((y, p) => y + Math.round(p.height * width / p.width) + 18, 0));
        }
      }
    }
  });

  it("moves ink written on split sheets onto the same half of the whole sheet", () => {
    // A two-up scan: every sheet is two book pages side by side.
    const pages = Array.from({ length: 5 }, (_, i) => ({ pageNumber: i + 1, width: 1200, height: 800 }));
    const width = 1000;
    const split = conflictPdfFrames(pages, width, true);
    const whole = conflictPdfFrames(pages, width, false);
    expect(split).toHaveLength(10);
    expect(whole).toHaveLength(5);
    // Three-quarters across and halfway down the right-hand page of sheet 3.
    const right = split.filter((f) => f.pageId === 3)[1]!;
    const y = right.minY + (right.maxY - right.minY) / 2;
    const [moved] = remapInkBetweenPdfLayouts(
      [{ kind: "erase", radius: 1, points: [{ x: 750, y, pressure: 1 }] }],
      split, whole, 0, width,
    );
    const sheet = whole.find((f) => f.pageId === 3)!;
    const pt = moved!.points[0]!;
    expect(pt.y).toBeCloseTo(sheet.minY + (sheet.maxY - sheet.minY) / 2, 3);
    expect(pt.x).toBeCloseTo(500 + 0.75 * 500, 3);
  });

  it("reads which layout a copy stamped, and nothing from an older one", () => {
    expect(inkSpreadOf({ board: { appState: { pdfSpread: true } } })).toBe(true);
    expect(inkSpreadOf({ board: { appState: { pdfSpread: false } } })).toBe(false);
    expect(inkSpreadOf({ board: { appState: {} } })).toBeUndefined();
    expect(inkSpreadOf(null)).toBeUndefined();
  });
});
