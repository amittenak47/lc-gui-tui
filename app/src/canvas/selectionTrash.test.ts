import { describe, expect, it } from "vitest";

import {
  isDeletableElement,
  selectionBounds,
  trashAnchor,
  withLiveTrashEls,
  TRASH_GAP_PX,
  TRASH_SIZE_PX,
  type TrashEl,
} from "./selectionTrash";

function el(patch: Partial<TrashEl> = {}): TrashEl {
  return { id: "el-1", x: 0, y: 0, ...patch };
}

/**
 * The trash used to appear only for library stamps, so a rectangle you drew
 * could be selected, moved and resized but not removed — and there is no
 * keyboard on the tablet this is written on.
 */
describe("isDeletableElement", () => {
  it("takes a plain shape the reader drew", () => {
    expect(isDeletableElement(el())).toBe(true);
  });

  it("takes a library stamp, which is all it used to take", () => {
    expect(isDeletableElement(el({ customData: { lcStamp: true } }))).toBe(true);
  });

  it("takes every reader-placed Excalidraw type the board can hold", () => {
    // Enumerate rather than spot-check: a new shape tool that slipped past the
    // trash would be invisible on a tablet with no keyboard. Deletability does
    // not key off `type` today — this list is the contract that none of these
    // ids accidentally look like scaffolding.
    for (const type of [
      "rectangle",
      "ellipse",
      "diamond",
      "arrow",
      "line",
      "freedraw",
      "text",
      "image",
      "frame",
      "embeddable",
    ]) {
      expect(isDeletableElement(el({ id: `reader-${type}` }))).toBe(true);
    }
  });

  it("leaves the page's own frames alone", () => {
    expect(isDeletableElement(el({ customData: { lcRegionFrame: true } }))).toBe(false);
    expect(isDeletableElement(el({ customData: { lcRegion: "approach" } }))).toBe(false);
    expect(isDeletableElement(el({ customData: { lcMdInkFrame: true } }))).toBe(false);
  });

  it("leaves template scaffolding recognised only by its id", () => {
    expect(isDeletableElement(el({ id: "lcregion-approach-label" }))).toBe(false);
  });

  it("leaves a locked element alone", () => {
    expect(isDeletableElement(el({ locked: true }))).toBe(false);
  });

  it("takes a coach-drawn diagram — the board is the reader's", () => {
    expect(isDeletableElement(el({ id: "viz-3" }))).toBe(true);
  });
});

describe("selectionBounds", () => {
  it("boxes a plain rectangle", () => {
    expect(selectionBounds([el({ x: 10, y: 20, width: 30, height: 40 })])).toEqual({
      minX: 10,
      minY: 20,
      maxX: 40,
      maxY: 60,
    });
  });

  it("normalises a box drawn right-to-left", () => {
    expect(selectionBounds([el({ x: 40, y: 60, width: -30, height: -40 })])).toEqual({
      minX: 10,
      minY: 20,
      maxX: 40,
      maxY: 60,
    });
  });

  it("follows an arrow's points, not its declared box", () => {
    // An arrow bent back on itself: the far corner is a bend, not the endpoint,
    // and `width`/`height` are stale while the line editor still has it.
    const arrow = el({
      x: 100,
      y: 100,
      width: 0,
      height: 0,
      points: [
        [0, 0],
        [50, -20],
        [20, 60],
      ],
    });
    expect(selectionBounds([arrow])).toEqual({
      minX: 100,
      minY: 80,
      maxX: 150,
      maxY: 160,
    });
  });

  it("spans a multi-element selection", () => {
    const bounds = selectionBounds([
      el({ id: "a", x: 0, y: 0, width: 10, height: 10 }),
      el({ id: "b", x: 90, y: 40, width: 10, height: 10 }),
    ]);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
  });

  it("has nothing to say about an empty selection", () => {
    expect(selectionBounds([])).toBeNull();
  });
});

describe("withLiveTrashEls", () => {
  it("prefers the in-flight clone over the committed scene copy", () => {
    const scene = el({ id: "arrow", x: 0, y: 0, points: [[0, 0], [40, 0]] });
    const dragging = el({ id: "arrow", x: 80, y: 10, points: [[0, 0], [40, 20]] });
    expect(withLiveTrashEls([scene], [dragging])).toEqual([dragging]);
  });
});

describe("trashAnchor", () => {
  const camera = { scrollX: 0, scrollY: 0, zoom: 1 };
  const viewport = { width: 1000, height: 800 };

  it("sits outside the selection's top-right corner", () => {
    const { left, top } = trashAnchor(
      { minX: 100, minY: 100, maxX: 200, maxY: 200 },
      camera,
      viewport,
    );
    // Clear to the right of the box, and clear above it — the whole point.
    expect(left).toBe(200 + TRASH_GAP_PX);
    expect(top).toBe(100 - TRASH_GAP_PX - TRASH_SIZE_PX);
  });

  it("never overlaps the selection it belongs to", () => {
    const box = { minX: 100, minY: 100, maxX: 200, maxY: 200 };
    const { left, top } = trashAnchor(box, camera, viewport);
    const overlaps =
      left < box.maxX &&
      left + TRASH_SIZE_PX > box.minX &&
      top < box.maxY &&
      top + TRASH_SIZE_PX > box.minY;
    expect(overlaps).toBe(false);
  });

  it("rides the camera", () => {
    const scrolled = trashAnchor(
      { minX: 100, minY: 100, maxX: 200, maxY: 200 },
      { scrollX: 50, scrollY: -30, zoom: 2 },
      viewport,
    );
    expect(scrolled.left).toBe((200 + 50) * 2 + TRASH_GAP_PX);
    expect(scrolled.top).toBe((100 - 30) * 2 - TRASH_GAP_PX - TRASH_SIZE_PX);
  });

  it("drops below the selection when it is against the top of the board", () => {
    const { top } = trashAnchor({ minX: 100, minY: 2, maxX: 200, maxY: 60 }, camera, viewport);
    expect(top).toBe(60 + TRASH_GAP_PX);
  });

  it("goes to the left of the selection when it is against the right edge", () => {
    const { left } = trashAnchor(
      { minX: 800, minY: 100, maxX: 995, maxY: 200 },
      camera,
      viewport,
    );
    expect(left).toBe(800 - TRASH_GAP_PX - TRASH_SIZE_PX);
  });

  it("stays on screen when the selection fills the board", () => {
    const { left, top } = trashAnchor(
      { minX: -50, minY: -50, maxX: 1050, maxY: 850 },
      camera,
      viewport,
    );
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(viewport.width - TRASH_SIZE_PX);
    expect(top).toBeLessThanOrEqual(viewport.height - TRASH_SIZE_PX);
  });
});
