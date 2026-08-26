import { describe, expect, it } from "vitest";

import { NO_PRESSURE, type InkDrawOp, type InkOp } from "./rasterInk";
import {
  SPANNING_PAGE_ID,
  binOpsByPage,
  fallbackPageFrames,
  lastPageId,
  lruWindow,
  offsetPageFrames,
  pageIdAtViewport,
  pageIdForOp,
  pageIdFromCamera,
  pageIdsIntersectingView,
  pageIndexForSceneY,
  scrollYForPage,
  type PageFrame,
} from "./inkPageIndex";

function frames(): PageFrame[] {
  // Two 100-tall pages with an 18-unit gap, matching PAGE_GAP.
  return [
    { pageId: 1, minY: 0, maxY: 100 },
    { pageId: 2, minY: 118, maxY: 218 },
    { pageId: 3, minY: 236, maxY: 336 },
  ];
}

function stroke(y0: number, y1 = y0): InkDrawOp {
  return {
    kind: "draw",
    color: "#000",
    baseWidth: 2,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: [
      { x: 10, y: y0, pressure: NO_PRESSURE },
      { x: 12, y: y1, pressure: NO_PRESSURE },
    ],
  };
}

describe("pageIndexForSceneY", () => {
  it("returns the page a Y sits inside", () => {
    expect(pageIndexForSceneY(50, frames())).toBe(1);
    expect(pageIndexForSceneY(150, frames())).toBe(2);
    expect(pageIndexForSceneY(300, frames())).toBe(3);
  });

  it("sends a gap Y to the nearer neighbour", () => {
    expect(pageIndexForSceneY(105, frames())).toBe(1);
    expect(pageIndexForSceneY(115, frames())).toBe(2);
  });

  it("returns 1 when there are no frames", () => {
    expect(pageIndexForSceneY(0, [])).toBe(1);
  });
});

describe("pageIdForOp", () => {
  it("bins a stroke that lives on one page", () => {
    expect(pageIdForOp(stroke(40), frames())).toBe(1);
    expect(pageIdForOp(stroke(200), frames())).toBe(2);
  });

  it("sends a gap-only stroke to the spanning shard, not duplicated", () => {
    expect(pageIdForOp(stroke(108, 110), frames())).toBe(SPANNING_PAGE_ID);
  });

  it("sends a stroke that crosses a seam to page 0 once", () => {
    expect(pageIdForOp(stroke(90, 130), frames())).toBe(SPANNING_PAGE_ID);
  });

  it("keeps a stroke that spans two-up halves of the same PDF page", () => {
    const spread: PageFrame[] = [
      { pageId: 1, minY: 0, maxY: 100 },
      { pageId: 1, minY: 118, maxY: 218 },
      { pageId: 2, minY: 236, maxY: 336 },
    ];
    expect(pageIdForOp(stroke(90, 130), spread)).toBe(1);
    expect(pageIdForOp(stroke(200, 250), spread)).toBe(SPANNING_PAGE_ID);
  });

  it("bins everything to page 1 on a single-frame document", () => {
    const one = fallbackPageFrames({ minX: 0, minY: 0, maxX: 100, maxY: 800 });
    expect(pageIdForOp(stroke(400), one)).toBe(1);
    expect(binOpsByPage([stroke(10), stroke(700)], one).get(1)).toHaveLength(2);
  });
});

describe("binOpsByPage", () => {
  it("does not copy a spanning stroke onto both neighbours", () => {
    const ops: InkOp[] = [stroke(40), stroke(90, 130), stroke(200)];
    const bins = binOpsByPage(ops, frames());
    expect(bins.get(1)).toHaveLength(1);
    expect(bins.get(2)).toHaveLength(1);
    expect(bins.get(SPANNING_PAGE_ID)).toHaveLength(1);
    expect(bins.size).toBe(3);
  });
});

describe("lruWindow", () => {
  it("keeps spanning plus current ± radius, not 32 pages", () => {
    expect(lruWindow(50, 1500, 3)).toEqual([0, 47, 48, 49, 50, 51, 52, 53]);
  });

  it("clamps at the ends of the book", () => {
    expect(lruWindow(1, 10, 3)).toEqual([0, 1, 2, 3, 4]);
    expect(lruWindow(10, 10, 3)).toEqual([0, 7, 8, 9, 10]);
  });
});

describe("pageIdAtViewport", () => {
  it("names the page at the vertical center of the band, not the top sheet", () => {
    expect(pageIdAtViewport(frames(), 0, 80)).toBe(1);
    expect(pageIdAtViewport(frames(), 160, 240)).toBe(2);
    // Hole covers the bottom of 1 and most of 2 — center is on 2.
    expect(pageIdAtViewport(frames(), 90, 170)).toBe(2);
  });
});

describe("lastPageId", () => {
  it("is the highest 1-based page, ignoring spanning", () => {
    expect(lastPageId(frames())).toBe(3);
    expect(lastPageId([])).toBe(1);
  });
});

describe("pageIdFromCamera", () => {
  it("maps a saved camera onto the page at the hole center", () => {
    expect(pageIdFromCamera(frames(), 0, 1, 80)).toBe(1);
    expect(pageIdFromCamera(frames(), -160, 1, 80)).toBe(2);
    expect(pageIdFromCamera(frames(), -90, 1, 80)).toBe(2);
  });
});

describe("pageIdsIntersectingView", () => {
  it("is every overlapping page, not C+1 through C+5", () => {
    expect(pageIdsIntersectingView(frames(), 0, 1, 80)).toEqual([1]);
    expect(pageIdsIntersectingView(frames(), -160, 1, 40)).toEqual([2]);
  });

  it("returns two ids when the hole covers a seam", () => {
    expect(pageIdsIntersectingView(frames(), -90, 1, 80)).toEqual([1, 2]);
  });

  it("uses the same camera band as pageIdFromCamera", () => {
    const C = pageIdFromCamera(frames(), -160, 1, 80);
    const overlap = pageIdsIntersectingView(frames(), -160, 1, 80);
    expect(overlap).toContain(C);
  });
});

describe("offsetPageFrames", () => {
  it("shifts document-local frames into the page-frame origin", () => {
    expect(offsetPageFrames(frames(), 40)[0]).toEqual({
      pageId: 1,
      minY: 40,
      maxY: 140,
    });
    expect(offsetPageFrames([], 40)).toEqual([]);
  });
});

describe("scrollYForPage", () => {
  it("puts the page top at the chrome inset", () => {
    expect(scrollYForPage(frames(), 2, 1, 0)).toBe(-118);
    expect(scrollYForPage(frames(), 2, 1, 10)).toBe(-108);
    expect(scrollYForPage(frames(), 9, 1)).toBeNull();
  });

  it("jumps to the left half when a PDF page has two stacked slots", () => {
    const spread: PageFrame[] = [
      { pageId: 1, minY: 0, maxY: 100 },
      { pageId: 1, minY: 118, maxY: 218 },
    ];
    expect(scrollYForPage(spread, 1, 1, 0)).toBe(0);
  });
});
