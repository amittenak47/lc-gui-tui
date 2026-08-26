import { describe, expect, it } from "vitest";

import { PDF_PREVIEW_SCALE, PDF_REST_SCALE } from "../perfPreset";
import {
  pageNeedsDecode,
  pdfDecodeQueue,
  pdfOuterPages,
  pdfPaintHole,
  pdfPaintShouldWaitForLanding,
  pdfRestPages,
  pdfShouldPreempt,
} from "./pdfPaintWindow";

describe("pdfRestPages", () => {
  it("is C±1 union the hole list, not C+1…C+5", () => {
    expect(pdfRestPages(50, 200, [50])).toEqual([49, 50, 51]);
    expect(pdfRestPages(50, 200, [50, 51])).toEqual([49, 50, 51]);
    expect(pdfRestPages(1, 200, [1])).toEqual([1, 2]);
    expect(pdfRestPages(50, 200, [50]).includes(55)).toBe(false);
  });
});

describe("pdfDecodeQueue", () => {
  it("is visible 0.25, then rest 2, then C+2 at 0.25 — not C+5", () => {
    const C = 50;
    const last = 200;
    const rest = new Set(pdfRestPages(C, last, [50]));
    const outer = new Set(pdfOuterPages(C, last));
    const scaleOf = (n: number) => (n === 50 ? 0.25 : 0);
    const fitOf = () => 1;
    const queue = pdfDecodeQueue(C, last, rest, outer, [50], scaleOf, fitOf);
    expect(queue.find((item) => item.page === 50)).toEqual({
      page: 50,
      target: PDF_REST_SCALE,
    });
    expect(queue[0]?.page).toBe(50);
    expect(queue.some((item) => item.page === 52 && item.target === PDF_PREVIEW_SCALE)).toBe(
      true,
    );
    expect(queue.some((item) => item.page === 52 && item.target === PDF_REST_SCALE)).toBe(
      false,
    );
    expect(queue.some((item) => item.page === 55)).toBe(false);
  });

  it("skips pdf.js when RAM already meets the target", () => {
    const rest = new Set([49, 50, 51]);
    const outer = new Set(pdfOuterPages(50, 200));
    const scaleOf = (n: number) => (rest.has(n) ? 2 : 0.25);
    const queue = pdfDecodeQueue(50, 200, rest, outer, [50], scaleOf, () => 1);
    expect(queue.some((item) => item.page === 50)).toBe(false);
  });

  it("preempts a neighbor 0.25 when the hole is blank, and upgrades C to rest 2", () => {
    const hole = new Set([50]);
    const rest = new Set([49, 50, 51]);
    expect(
      pdfShouldPreempt(
        { page: 52, target: PDF_PREVIEW_SCALE },
        { page: 50, target: PDF_PREVIEW_SCALE },
        50,
        hole,
        rest,
      ),
    ).toBe(true);
    expect(
      pdfShouldPreempt(
        { page: 50, target: PDF_PREVIEW_SCALE },
        { page: 50, target: PDF_REST_SCALE },
        50,
        hole,
        rest,
      ),
    ).toBe(true);
    expect(
      pdfShouldPreempt(
        { page: 50, target: PDF_REST_SCALE },
        { page: 52, target: PDF_PREVIEW_SCALE },
        50,
        hole,
        rest,
      ),
    ).toBe(false);
  });
});

describe("pdfPaintShouldWaitForLanding", () => {
  it("skips page 1..32 while C is still in a later layout batch", () => {
    expect(pdfPaintShouldWaitForLanding(47, 32)).toBe(true);
    expect(pdfPaintShouldWaitForLanding(47, 47)).toBe(false);
    expect(pdfPaintShouldWaitForLanding(1, 32)).toBe(false);
  });
});

describe("pdfPaintHole", () => {
  it("does not treat page 1 as the hole while C is the session page", () => {
    expect(pdfPaintHole(47, [1])).toEqual([47]);
    expect(pdfPaintHole(47, [])).toEqual([47]);
    expect(pdfPaintHole(47, [46, 47])).toEqual([46, 47]);
  });
});

describe("pageNeedsDecode after rotate / spread", () => {
  it("does not re-decode rest 2 when fit is unchanged", () => {
    expect(pageNeedsDecode(1, 2, 2)).toBe(false);
  });

  it("skips pdf.js on spread when stored pixels still cover the target", () => {
    const oneUpFit = 1;
    const spreadFit = 2;
    const storedRest = oneUpFit * 2;
    expect(pageNeedsDecode(spreadFit, PDF_PREVIEW_SCALE, storedRest)).toBe(false);
    expect(pageNeedsDecode(spreadFit, PDF_REST_SCALE, storedRest)).toBe(true);
  });
});
