import { describe, expect, it } from "vitest";

import {
  conflictFitSpan,
  conflictInkPlacement,
  conflictInkXBounds,
  conflictOpsForPage,
  conflictPaperFrames,
  conflictPaperPageStyle,
  mergeConflictPageFrames,
  expandLumpedInkDiffRows,
  whiteboardInkMergeRows,
  inkPageIdsFromOps,
  inkSlotsEqual,
  inkedPageIds,
  type ConflictInkSlot,
} from "./conflictInkLayout";
import { NO_PRESSURE, type InkDrawOp } from "../canvas/rasterInk";
import { SCRATCH_PAGE_H, SCRATCH_PAGE_GUTTER, whiteboardMergeFrames, whiteboardPageFrames } from "../templates/whiteboard";

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

  it("leaves the spanning shard off a textbook, and onto page 1 when it is the only ink", () => {
    /*
     * Page 0 is where strokes go when their box crosses a page gap. On a
     * textbook it belongs to no single slot. On a one-page pad it is still
     * the page, so the preview has to draw it there.
     */
    expect(inkedPageIds([{ page_id: 0 }, { page_id: 3 }])).toEqual([3]);
    expect(inkedPageIds([{ page_id: 0 }])).toEqual([1]);
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
    expect(conflictInkPlacement(slot(), undefined, 540).originX).toBe(0);
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
    expect(placed.originX).toBe(0);
  });

  it("width-fits ink that starts left of the page so the first letters are not clipped", () => {
    /*
     * The whiteboard unions the sheet with ink that sits left of the frame
     * and width-fits that box. Origin zero here was the merge-window bug:
     * strokes that began at the left edge (or a hair past it) were painted
     * against the pane's clip and the first letters vanished.
     */
    const placed = conflictInkPlacement(
      slot({ width: 392, left: 0, top: 0, height: 420 }),
      { pageId: 1, minY: 0, maxY: 4200 },
      3920,
      { minX: -200, maxX: 1800 },
    );
    expect(placed.originX).toBe(-200);
    expect(placed.scale).toBe(392 / (3920 + 200));
    expect(placed.originY).toBe(0);
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

function stroke(y: number): InkDrawOp {
  return {
    kind: "draw",
    color: "#111",
    baseWidth: 4,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: [
      { x: 80, y, pressure: NO_PRESSURE },
      { x: 120, y, pressure: NO_PRESSURE },
    ],
  };
}

describe("conflictOpsForPage", () => {
  const frames = whiteboardPageFrames(2);

  it("puts page-1-blob strokes onto the visual page they were written on", () => {
    const page2Y = frames[1]!.minY + 40;
    const ops = [stroke(40), stroke(page2Y)];
    expect(conflictOpsForPage(ops, 1, frames)).toHaveLength(1);
    expect(conflictOpsForPage(ops, 2, frames)).toHaveLength(1);
  });
});

describe("conflictPaperFrames", () => {
  it("grows the stack when ink sits past the last template page", () => {
    const frames = conflictPaperFrames(undefined, 1, SCRATCH_PAGE_H * 2.5);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.at(-1)!.maxY).toBeGreaterThan(SCRATCH_PAGE_H * 2);
  });

  it("keeps live grown heights when they already cover the ink", () => {
    const live = [{ pageId: 1, minY: 0, maxY: 8000 }];
    expect(conflictPaperFrames(live, 1, 7000)).toEqual(live);
  });
});

describe("conflictFitSpan", () => {
  it("unions ink that sits left of the page into the fit width", () => {
    const span = conflictFitSpan(3920, { minX: -200, maxX: 1800 });
    expect(span?.minX).toBe(-200);
    expect(span?.width).toBe(4120);
  });
});

describe("conflictInkXBounds", () => {
  it("includes stroke width so left-edge letters are not clipped", () => {
    const bounds = conflictInkXBounds([stroke(40)]);
    expect(bounds).not.toBeNull();
    expect(bounds!.minX).toBeLessThan(80);
  });
});

describe("conflictPaperPageStyle", () => {
  it("sizes the sheet to the fitted box the ink is painted in", () => {
    const style = conflictPaperPageStyle(
      { pageId: 1, minY: 0, maxY: 4200 },
      3920,
      true,
      4120,
    );
    expect(style.aspectRatio).toBe("4120 / 4200");
  });
});

describe("mergeConflictPageFrames", () => {
  it("keeps grown live heights and extra pages from the other copy", () => {
    const merged = mergeConflictPageFrames(
      [{ pageId: 1, minY: 0, maxY: 8000 }],
      [
        { pageId: 1, minY: 0, maxY: 4200 },
        { pageId: 2, minY: 4264, maxY: 8464 },
      ],
    );
    expect(merged).toEqual([
      { pageId: 1, minY: 0, maxY: 8000 },
      { pageId: 2, minY: 4264, maxY: 8464 },
    ]);
  });
});

describe("expandLumpedInkDiffRows", () => {
  const frames = whiteboardPageFrames(2);

  it("keeps a real per-page list alone", () => {
    const rows = [
      { pageId: 2, hasLocal: true, hasServer: true },
      { pageId: 3, hasLocal: true, hasServer: false },
    ];
    expect(expandLumpedInkDiffRows(rows, frames, [2], [2])).toEqual(rows);
  });

  it("splits a page-1 blob onto the pads the strokes sit on", () => {
    const expanded = expandLumpedInkDiffRows(
      [{ pageId: 1, hasLocal: true, hasServer: true }],
      frames,
      [1, 2],
      [1],
    );
    expect(expanded).toEqual([
      { pageId: 1, hasLocal: true, hasServer: true },
      { pageId: 2, hasLocal: true, hasServer: false },
    ]);
  });

  it("still splits when the pad only stored one template frame", () => {
    const expanded = expandLumpedInkDiffRows(
      [{ pageId: 1, hasLocal: true, hasServer: true }],
      whiteboardPageFrames(1),
      [1, 2],
      [1, 2],
    );
    expect(expanded.map((row) => row.pageId)).toEqual([1, 2]);
  });
});

describe("inkPageIdsFromOps", () => {
  it("names every notebook page a lumped blob actually wrote on", () => {
    const frames = whiteboardPageFrames(2);
    const ops = [stroke(40), stroke(frames[1]!.minY + 40)];
    expect(inkPageIdsFromOps(ops, frames)).toEqual([1, 2]);
  });
});

describe("whiteboardInkMergeRows", () => {
  it("splits a grown page-1 blob onto the sheets the strokes sit on", () => {
    const y2 = SCRATCH_PAGE_H + SCRATCH_PAGE_GUTTER + 40;
    const frames = whiteboardMergeFrames(1, y2);
    expect(frames.length).toBeGreaterThan(1);
    const rows = whiteboardInkMergeRows(
      [{ pageId: 1, hasLocal: true, hasServer: true }],
      frames,
      [stroke(40), stroke(y2)],
      [stroke(80)],
    );
    expect(rows).toEqual([
      { pageId: 1, hasLocal: true, hasServer: true },
      { pageId: 2, hasLocal: true, hasServer: false },
    ]);
  });

  it("omits a virtual page whose strokes already match", () => {
    const y2 = SCRATCH_PAGE_H + SCRATCH_PAGE_GUTTER + 40;
    const frames = whiteboardMergeFrames(1, y2);
    const page2 = stroke(y2);
    const rows = whiteboardInkMergeRows(
      [{ pageId: 1, hasLocal: true, hasServer: true }],
      frames,
      [stroke(40), page2],
      [stroke(80), page2],
    );
    expect(rows).toEqual([{ pageId: 1, hasLocal: true, hasServer: true }]);
  });
});
