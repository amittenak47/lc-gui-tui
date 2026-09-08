/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  escapeAttrSelector,
  hasUsableViewportBox,
  liveFootnoteAnchorRect,
  subscribePageSurfaceMove,
  viewportBoxesOverlap,
} from "./sheetAnchor";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("viewportBoxesOverlap", () => {
  it("accepts a sliver of the mark still in the pane", () => {
    expect(
      viewportBoxesOverlap(
        { left: 0, top: 90, right: 40, bottom: 110 },
        { left: 0, top: 0, right: 100, bottom: 100 },
      ),
    ).toBe(true);
  });

  it("rejects a mark that has left the pane", () => {
    expect(
      viewportBoxesOverlap(
        { left: 0, top: 120, right: 40, bottom: 140 },
        { left: 0, top: 0, right: 100, bottom: 100 },
      ),
    ).toBe(false);
  });
});

describe("hasUsableViewportBox", () => {
  it("ignores an unmeasured jsdom box", () => {
    expect(hasUsableViewportBox({ width: 0, height: 0 })).toBe(false);
    expect(hasUsableViewportBox({ width: 12, height: 4 })).toBe(true);
  });
});

describe("liveFootnoteAnchorRect", () => {
  it("unions quote bands for the matching pack", () => {
    const pack = document.createElement("div");
    pack.className = "lc-doc-footnote-pack";
    pack.dataset.footnoteId = "fn-1";
    const a = document.createElement("div");
    a.className = "lc-doc-footnote-band";
    const b = document.createElement("div");
    b.className = "lc-doc-footnote-band";
    pack.append(a, b);
    document.body.append(pack);
    vi.spyOn(a, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 40, 8),
    );
    vi.spyOn(b, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 32, 30, 8),
    );
    const box = liveFootnoteAnchorRect("fn-1");
    expect(box?.left).toBe(10);
    expect(box?.top).toBe(20);
    expect(box?.width).toBe(40);
    expect(box?.height).toBe(20);
  });

  it("picks the pack nearest the open-hint when ids collide", () => {
    const left = document.createElement("div");
    left.className = "lc-doc-footnote-pack";
    left.dataset.footnoteId = "same";
    const right = document.createElement("div");
    right.className = "lc-doc-footnote-pack";
    right.dataset.footnoteId = "same";
    const leftBand = document.createElement("div");
    leftBand.className = "lc-doc-footnote-band";
    const rightBand = document.createElement("div");
    rightBand.className = "lc-doc-footnote-band";
    left.append(leftBand);
    right.append(rightBand);
    document.body.append(left, right);
    vi.spyOn(left, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 20, 20),
    );
    vi.spyOn(right, "getBoundingClientRect").mockReturnValue(
      new DOMRect(200, 0, 20, 20),
    );
    vi.spyOn(leftBand, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 20, 8),
    );
    vi.spyOn(rightBand, "getBoundingClientRect").mockReturnValue(
      new DOMRect(200, 0, 20, 8),
    );
    const box = liveFootnoteAnchorRect("same", {
      left: 198,
      top: 0,
      width: 10,
      height: 10,
    });
    expect(box?.left).toBe(200);
  });
});

describe("subscribePageSurfaceMove", () => {
  it("notifies when a nested board host scrolls", async () => {
    const board = document.createElement("div");
    board.className = "lc-board";
    document.body.append(board);
    const onMove = vi.fn();
    const stop = subscribePageSurfaceMove(onMove);
    board.dispatchEvent(new Event("scroll", { bubbles: false }));
    await vi.waitFor(() => {
      expect(onMove).toHaveBeenCalled();
    });
    stop();
  });
});

describe("escapeAttrSelector", () => {
  it("keeps a plain footnote id query-safe", () => {
    expect(escapeAttrSelector("fn-1")).toBe("fn-1");
  });
});
