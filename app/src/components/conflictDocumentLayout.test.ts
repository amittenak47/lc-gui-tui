import { describe, expect, it } from "vitest";
import { conflictDocumentWidth, conflictPdfFrames } from "./conflictDocumentLayout";
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
});
