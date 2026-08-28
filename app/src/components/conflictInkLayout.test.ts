import { describe, expect, it } from "vitest";

import {
  conflictInkPlacement,
  inkSlotsEqual,
  inkedPageIds,
  type ConflictInkSlot,
} from "./conflictInkLayout";

const slot = (over: Partial<ConflictInkSlot> = {}): ConflictInkSlot => ({
  page: 6,
  left: 0,
  top: 1750,
  width: 270,
  height: 350,
  ...over,
});

describe("inkedPageIds", () => {
  it("names each page that carries strokes, once, in order", () => {
    expect(
      inkedPageIds([{ page_id: 6 }, { page_id: 2 }, { page_id: 6 }]),
    ).toEqual([2, 6]);
  });

  it("leaves the spanning shard out", () => {
    /*
     * Page 0 is where strokes go when their box crosses a page gap. It belongs
     * to no single slot, and treating the id as a page number would draw those
     * strokes on page one.
     */
    expect(inkedPageIds([{ page_id: 0 }, { page_id: 3 }])).toEqual([3]);
    expect(inkedPageIds([{ page_id: 0 }])).toEqual([]);
  });

  it("has nothing to say about a pad with no ink", () => {
    expect(inkedPageIds(undefined)).toEqual([]);
    expect(inkedPageIds([])).toEqual([]);
  });
});

describe("conflictInkPlacement", () => {
  it("scales scene units into this pane's width", () => {
    // The pane lays the same page out narrower than the board did.
    expect(conflictInkPlacement(slot(), undefined, 540).scale).toBe(0.5);
    expect(conflictInkPlacement(slot({ width: 540 }), undefined, 540).scale).toBe(1);
  });

  it("starts the paint at the page's own scene Y", () => {
    /*
     * The whole bug in one number. Strokes carry an absolute scene Y down the
     * stack, so page 6's ink sits near 1750 in a 350-unit-per-page book —
     * painting it from origin zero puts it five pages below where it belongs.
     */
    const placed = conflictInkPlacement(
      slot(),
      { pageId: 6, minY: 1750, maxY: 2100 },
      540,
    );
    expect(placed.originY).toBe(1750);
  });

  it("does not put every page at the top of the book", () => {
    const six = conflictInkPlacement(slot(), { pageId: 6, minY: 1750, maxY: 2100 }, 540);
    const forty = conflictInkPlacement(
      slot({ page: 40 }),
      { pageId: 40, minY: 13650, maxY: 14000 },
      540,
    );
    expect(six.originY).not.toBe(forty.originY);
  });

  it("reads the page's own position when the frames are not there", () => {
    /*
     * Zero was the old fallback, and it is the bug: the same window of the
     * stack drawn onto every canvas — the top of the book repeated down the
     * pane, or nothing once the strokes are past it. The pane has measured
     * where this page sits, so that measurement stands in.
     */
    const placed = conflictInkPlacement(slot(), undefined, 540);
    expect(placed.scale).toBe(0.5);
    expect(placed.originY).toBe(3500);
  });

  it("gives each page a different origin without any frames at all", () => {
    // The symptom this fixes: both sides, and every page, painting the same
    // strokes because they all started from the same place.
    const six = conflictInkPlacement(slot({ page: 6, top: 1750 }), undefined, 540);
    const forty = conflictInkPlacement(slot({ page: 40, top: 13650 }), undefined, 540);
    expect(six.originY).not.toBe(forty.originY);
    expect(forty.originY).toBe(27300);
  });

  it("still prefers the board's frame, which is the scene ink was drawn in", () => {
    const placed = conflictInkPlacement(
      slot({ top: 1750 }),
      { pageId: 6, minY: 1800, maxY: 2150 },
      540,
    );
    expect(placed.originY).toBe(1800);
  });

  it("does not divide by a scene width it was never given", () => {
    expect(conflictInkPlacement(slot(), undefined, undefined).scale).toBe(1);
    expect(conflictInkPlacement(slot(), undefined, 0).scale).toBe(1);
  });
});

describe("inkSlotsEqual", () => {
  it("holds the same reference through a re-measure that moved nothing", () => {
    // The measure effect writes state; without this it would write a new array
    // every layout pass and re-run the paint against itself.
    expect(inkSlotsEqual([slot()], [slot()])).toBe(true);
    expect(inkSlotsEqual([slot()], [slot({ top: 1750.4 })])).toBe(true);
  });

  it("notices a page that actually moved", () => {
    expect(inkSlotsEqual([slot()], [slot({ top: 1800 })])).toBe(false);
    expect(inkSlotsEqual([slot()], [slot({ width: 300 })])).toBe(false);
    expect(inkSlotsEqual([slot()], [])).toBe(false);
    expect(inkSlotsEqual([slot()], [slot({ page: 7 })])).toBe(false);
  });
});

describe("what a canvas per page is worth", () => {
  it("bounds the surface by the page, not by the book", () => {
    /*
     * This was one canvas sized to the whole stack: on a 330-page textbook at
     * 350px a page that is ~115,000px tall, past what a browser will allocate,
     * and an absolutely positioned element that tall also blows out the
     * scroller. Turning handwriting on blanked the pane instead of drawing.
     */
    const pages = 330;
    const pageHeight = 350;
    const stack = pages * pageHeight;
    expect(stack).toBeGreaterThan(65535);

    const inked = inkedPageIds([{ page_id: 6 }]);
    const surface = inked.length * pageHeight;
    expect(surface).toBe(pageHeight);
    expect(surface).toBeLessThan(65535);
  });
});
