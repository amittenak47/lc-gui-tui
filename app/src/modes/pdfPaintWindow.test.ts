import { describe, expect, it } from "vitest";

import { PDF_PREVIEW_SCALE, PDF_REST_SCALE } from "../perfPreset";
import {
  nextPdfPageMissingText,
  pageNeedsDecode,
  pdfDecodeQueue,
  pdfLandingHoldClear,
  pdfMayTakeWorker,
  pdfLiveCanvasCap,
  pdfOuterPages,
  pdfPaintHole,
  pdfPaintShouldWaitForLanding,
  pdfQueueForHoldDecode,
  pdfWantedPages,
  pdfPreloadPages,
  pdfRestPages,
  pdfShouldPreempt,
  pdfVisibleFromSpans,
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

describe("pdfMayTakeWorker", () => {
  it("only parks drop the worker; a visible unfocused pane may still decode 0.25", () => {
    expect(pdfMayTakeWorker(false, false)).toBe(true);
    expect(pdfMayTakeWorker(true, false)).toBe(false);
    expect(pdfMayTakeWorker(false, true)).toBe(true);
    expect(pdfMayTakeWorker(true, true)).toBe(false);
  });
});

describe("pdfWantedPages", () => {
  it("keeps every sheet in the hole, not only C±3", () => {
    expect(pdfWantedPages(17, 200, [12, 13, 14, 15, 16, 17, 18, 19, 20])).toEqual([
      12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(pdfWantedPages(50, 200, [50])).toEqual([47, 48, 49, 50, 51, 52, 53]);
  });
});

describe("pdfLiveCanvasCap", () => {
  it("is the ring at reading zoom and the hole when zoomed out, capped at 12", () => {
    expect(pdfLiveCanvasCap(1)).toBe(7);
    expect(pdfLiveCanvasCap(12)).toBe(12);
    expect(pdfLiveCanvasCap(20)).toBe(12);
  });
});

describe("pdfQueueForHoldDecode", () => {
  it("drops rest-2 and pages outside the hole", () => {
    const queue = [
      { page: 50, target: PDF_REST_SCALE },
      { page: 50, target: PDF_PREVIEW_SCALE },
      { page: 60, target: PDF_PREVIEW_SCALE },
    ];
    expect(pdfQueueForHoldDecode(queue, [50, 51])).toEqual([
      { page: 50, target: PDF_PREVIEW_SCALE },
    ]);
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

describe("pdfVisibleFromSpans", () => {
  /*
   * What a CSS-scrolled pane has instead of a camera. The conflict panes went
   * to placeholders mid-flick because nobody published a paint window for
   * them — the board publishes one every frame from its camera, and a pane
   * that scrolls with overflow has only boxes to publish from.
   */
  const page = (n: number, top: number, height = 100) => ({
    page: n,
    top,
    bottom: top + height,
  });

  it("reports every page the viewport touches", () => {
    const spans = [page(1, -40), page(2, 60), page(3, 160), page(4, 260)];
    expect(pdfVisibleFromSpans(spans, 0, 200).intersecting).toEqual([1, 2, 3]);
  });

  it("calls the most-covered page current, not the topmost", () => {
    // A sliver of the previous page hanging into view is not what you read.
    const spans = [page(1, -95), page(2, 5)];
    expect(pdfVisibleFromSpans(spans, 0, 200).current).toBe(2);
  });

  it("switches current as the scroll carries the next page over the fold", () => {
    const spans = [page(1, -60), page(2, 40)];
    expect(pdfVisibleFromSpans(spans, 0, 100).current).toBe(2);
    // Scrolled back up: page one covers more again.
    expect(pdfVisibleFromSpans([page(1, -20), page(2, 80)], 0, 100).current).toBe(1);
  });

  it("says nothing rather than page one when the stack is off screen", () => {
    // The caller reads 0 as "no window to publish yet"; answering 1 would
    // point the paint window at the wrong end of the book.
    expect(pdfVisibleFromSpans([page(1, 400)], 0, 200)).toEqual({
      intersecting: [],
      current: 0,
    });
    expect(pdfVisibleFromSpans([], 0, 200).current).toBe(0);
  });

  it("ignores a page that only touches the edge", () => {
    // Exactly abutting is not overlapping, and a zero-height sliver is not a
    // page being read.
    expect(pdfVisibleFromSpans([page(1, -100), page(2, 0)], 0, 200).intersecting).toEqual([2]);
  });

  it("takes the widest slot when a spread puts one page in two", () => {
    const spans = [
      { page: 2, top: 0, bottom: 30 },
      { page: 2, top: 30, bottom: 180 },
      { page: 3, top: 180, bottom: 220 },
    ];
    const seen = pdfVisibleFromSpans(spans, 0, 200);
    expect(seen.intersecting).toEqual([2, 3]);
    expect(seen.current).toBe(2);
  });

  it("feeds the same rest window the board publishes", () => {
    const spans = [page(9, -50), page(10, 50), page(11, 150)];
    const { intersecting, current } = pdfVisibleFromSpans(spans, 0, 200);
    expect(pdfRestPages(current, 40, intersecting)).toEqual([9, 10, 11]);
  });
});

describe("nextPdfPageMissingText", () => {
  /** A page with a picture, a text layer and no reason to be revisited. */
  const quotable = {
    laidOut: true,
    painted: true,
    hasSpans: true,
    filled: true,
  };
  const from = (states: Record<number, Partial<typeof quotable>>) =>
    (page: number) => ({ ...quotable, ...(states[page] ?? {}) });

  it("finds a page painted under a live camera that never got its spans", () => {
    // The reader can read it and cannot quote it: the decode queue is done
    // with the page, so nothing but this would ever fill the layer.
    const stateOf = from({ 12: { hasSpans: false, filled: false } });
    expect(nextPdfPageMissingText([11, 12, 13], stateOf)).toBe(12);
  });

  it("leaves a page whose spans are already there", () => {
    const stateOf = from({ 12: { filled: false } });
    expect(nextPdfPageMissingText([11, 12, 13], stateOf)).toBeNull();
  });

  it("does not put spans over a sheet with no picture", () => {
    const stateOf = from({ 12: { painted: false, hasSpans: false, filled: false } });
    expect(nextPdfPageMissingText([12], stateOf)).toBeNull();
  });

  it("stops asking for a page with no text on it", () => {
    // A scanned plate lays out to an empty layer. Keyed on `hasSpans` the
    // pump would be handed it again every turn, forever.
    const stateOf = from({ 12: { hasSpans: false, filled: true } });
    expect(nextPdfPageMissingText([12], stateOf)).toBeNull();
  });

  it("skips a page with no slot, which the caller would decline anyway", () => {
    const stateOf = from({ 12: { laidOut: false, hasSpans: false, filled: false } });
    expect(nextPdfPageMissingText([12], stateOf)).toBeNull();
  });

  it("takes them in the order the caller asked", () => {
    const stateOf = from({
      9: { hasSpans: false, filled: false },
      12: { hasSpans: false, filled: false },
    });
    expect(nextPdfPageMissingText([12, 9], stateOf)).toBe(12);
    expect(nextPdfPageMissingText([9, 12], stateOf)).toBe(9);
  });

  it("ignores a page number that is not one", () => {
    const stateOf = from({ 0: { hasSpans: false, filled: false } });
    expect(nextPdfPageMissingText([0, -3], stateOf)).toBeNull();
  });
});
