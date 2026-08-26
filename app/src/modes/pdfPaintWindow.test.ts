import { describe, expect, it } from "vitest";

import { PDF_PREVIEW_SCALE, PDF_REST_SCALE } from "../perfPreset";
import {
  pageNeedsDecode,
  pdfDecodeQueue,
  pdfLandingHoldClear,
  pdfOuterPages,
  pdfPaintHole,
  pdfPaintShouldWaitForLanding,
  pdfPreloadPages,
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
  it("is C stub then C rest-2, then neighbours — not the whole 0.25 ring first", () => {
    const C = 50;
    const last = 200;
    const rest = new Set(pdfRestPages(C, last, [50]));
    const outer = new Set(pdfOuterPages(C, last));
    const scaleOf = (n: number) => (n === 50 ? 0.25 : 0);
    const fitOf = () => 1;
    const queue = pdfDecodeQueue(C, last, rest, outer, [50], scaleOf, fitOf);
    expect(queue[0]).toEqual({ page: 50, target: PDF_REST_SCALE });
    expect(queue[1]).toEqual({ page: 49, target: PDF_PREVIEW_SCALE });
    expect(queue.find((item) => item.page === 49 && item.target === PDF_REST_SCALE)).toEqual({
      page: 49,
      target: PDF_REST_SCALE,
    });
    const rest50 = queue.findIndex(
      (item) => item.page === 50 && item.target === PDF_REST_SCALE,
    );
    const preview52 = queue.findIndex(
      (item) => item.page === 52 && item.target === PDF_PREVIEW_SCALE,
    );
    expect(rest50).toBe(0);
    expect(preview52).toBeGreaterThan(rest50);
    expect(queue.some((item) => item.page === 55)).toBe(false);
  });

  it("does not rest-2 a cream C before its 0.25", () => {
    const rest = new Set(pdfRestPages(50, 200, [50]));
    const outer = new Set(pdfOuterPages(50, 200));
    const queue = pdfDecodeQueue(50, 200, rest, outer, [50], () => 0, () => 1);
    expect(queue[0]).toEqual({ page: 50, target: PDF_PREVIEW_SCALE });
    expect(queue[1]).toEqual({ page: 50, target: PDF_REST_SCALE });
  });

  it("skips pdf.js when RAM already meets the target", () => {
    const rest = new Set([49, 50, 51]);
    const outer = new Set(pdfOuterPages(50, 200));
    const scaleOf = (n: number) => (rest.has(n) ? 2 : 0.25);
    const queue = pdfDecodeQueue(50, 200, rest, outer, [50], scaleOf, () => 1);
    expect(queue.some((item) => item.page === 50)).toBe(false);
  });

  it("still queues rest-2 when layout fit is below 1 (spread off)", () => {
    const rest = new Set(pdfRestPages(50, 200, [50]));
    const outer = new Set(pdfOuterPages(50, 200));
    const scaleOf = (n: number) => (n === 50 ? PDF_PREVIEW_SCALE : 0);
    const queue = pdfDecodeQueue(50, 200, rest, outer, [50], scaleOf, () => 0.5);
    expect(
      queue.some(
        (item) => item.page === 50 && item.target === PDF_PREVIEW_SCALE,
      ),
    ).toBe(false);
    expect(queue.find((item) => item.page === 50 && item.target === PDF_REST_SCALE)).toEqual({
      page: 50,
      target: PDF_REST_SCALE,
    });
  });

  it("keeps repeating 0.25 at the head when scaleOf is fit×0.25", () => {
    const fit = 0.5;
    const rest = new Set(pdfRestPages(50, 200, [50]));
    const outer = new Set(pdfOuterPages(50, 200));
    const scaleOf = (n: number) => (n === 50 ? fit * PDF_PREVIEW_SCALE : 0);
    const queue = pdfDecodeQueue(50, 200, rest, outer, [50], scaleOf, () => fit);
    expect(queue[0]).toEqual({ page: 50, target: PDF_PREVIEW_SCALE });
    const restAt = queue.findIndex((item) => item.target === PDF_REST_SCALE);
    expect(restAt).toBeGreaterThan(0);
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

describe("pdfLandingHoldClear", () => {
  it("keeps C on the aimed page until camera Y actually lands there", () => {
    expect(pdfLandingHoldClear(47, 1)).toBe(false);
    expect(pdfLandingHoldClear(47, 47)).toBe(true);
    expect(pdfLandingHoldClear(0, 1)).toBe(false);
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
    const storedRest = oneUpFit * PDF_REST_SCALE;
    expect(pageNeedsDecode(spreadFit, PDF_PREVIEW_SCALE, storedRest)).toBe(false);
    expect(pageNeedsDecode(spreadFit, PDF_REST_SCALE, storedRest)).toBe(false);
  });
});

describe("pdfPreloadPages", () => {
  it("walks from live C toward the guess and caps at six 0.25 sheets", () => {
    expect(pdfPreloadPages(50, 58, 200)).toEqual([51, 52, 53, 54, 55, 56]);
    expect(pdfPreloadPages(50, 42, 200)).toEqual([49, 48, 47, 46, 45, 44]);
    expect(pdfPreloadPages(50, 50, 200)).toEqual([]);
  });
});

describe("pdfDecodeQueue preload", () => {
  it("appends 0.25 toward the guess after the ring, never rest-2", () => {
    const rest = new Set(pdfRestPages(50, 200, [50]));
    const outer = new Set(pdfOuterPages(50, 200));
    const scaleOf = (n: number) => (n === 50 ? 0.25 : 0);
    const queue = pdfDecodeQueue(
      50,
      200,
      rest,
      outer,
      [50],
      scaleOf,
      () => 1,
      [53, 54],
    );
    expect(queue.find((item) => item.page === 53)).toEqual({
      page: 53,
      target: PDF_PREVIEW_SCALE,
    });
    expect(queue.some((item) => item.page === 53 && item.target === PDF_REST_SCALE)).toBe(
      false,
    );
  });
});
