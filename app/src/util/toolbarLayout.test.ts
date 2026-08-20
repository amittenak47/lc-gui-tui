/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampToBox,
  loadToolbarLayout,
  saveToolbarLayout,
  TOOLBAR_DOCK_SNAP_PX,
  isNearDock,
  rectGap,
  toolbarAxis,
  toolbarWindowIsNarrow,
} from "./toolbarLayout";

const KEY = "whiteboard.toolbar.layout.v1";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("toolbarLayout", () => {
  it("defaults to docked", () => {
    expect(loadToolbarLayout()).toEqual({ mode: "docked" });
  });

  it("round-trips a floating position", () => {
    saveToolbarLayout({ mode: "floating", x: 40, y: 120 });
    expect(loadToolbarLayout()).toEqual({ mode: "floating", x: 40, y: 120 });
  });

  it("rejects corrupt payloads", () => {
    localStorage.setItem(KEY, '{"mode":"floating"}');
    expect(loadToolbarLayout()).toEqual({ mode: "docked" });
  });

  it("exports a usable dock snap radius", () => {
    expect(TOOLBAR_DOCK_SNAP_PX).toBeGreaterThan(40);
  });
});

describe("isNearDock", () => {
  const rect = (left: number, top: number, w: number, h: number) => ({
    left,
    top,
    right: left + w,
    bottom: top + h,
  });

  it("is zero gap when the boxes overlap", () => {
    expect(rectGap(rect(0, 0, 100, 100), rect(50, 50, 100, 100))).toBe(0);
  });

  it("measures the gap between edges, not centres", () => {
    expect(rectGap(rect(0, 0, 10, 10), rect(40, 0, 10, 10))).toBe(30);
  });

  it("lets a tall column dock on a slot it is already covering", () => {
    /*
     * The bug this replaced: a 200px column overlapping a 240px slot still had
     * its centre 90px from the slot's centre, so centre-to-centre said "not
     * near" and the island could not be put back — in a short window the clamp
     * would not let it fall far enough to close that gap.
     */
    const island = rect(300, 200, 36, 200);
    const slot = rect(304, 280, 36, 240);
    expect(isNearDock(island, slot)).toBe(true);
  });

  it("still says no when the island is nowhere near", () => {
    expect(isNearDock(rect(20, 20, 36, 200), rect(400, 300, 36, 240))).toBe(false);
  });
});

describe("clampToBox", () => {
  const board = { left: 0, top: 0, right: 2000, bottom: 1000 };

  it("leaves an in-bounds island alone", () => {
    expect(clampToBox(100, 200, 400, 40, board)).toEqual({ x: 100, y: 200 });
  });

  it("keeps the island out of a coach-sized right hole", () => {
    const hole = { left: 0, top: 64, right: 2000 - 520, bottom: 1000 };
    const next = clampToBox(1600, 900, 400, 40, hole);
    expect(next.x + 400).toBeLessThanOrEqual(hole.right - 8);
    expect(next.x).toBeGreaterThanOrEqual(hole.left + 8);
  });
});

describe("toolbarAxis", () => {
  it("stays a row when docked or near the dock snap", () => {
    expect(toolbarAxis("docked", 0, 400, 1280, false, "row", 400)).toBe("row");
    expect(toolbarAxis("floating", 10, 48, 1280, true, "row", 400)).toBe("row");
  });

  it("becomes a column only when the window itself runs out of room", () => {
    expect(toolbarAxis("docked", 0, 400, 380, false, "row", 400)).toBe("column");
    expect(toolbarAxis("docked", 0, 400, 300, false, "row", 250)).toBe("column");
  });

  it("ignores the pane the island is drawn over", () => {
    // The thin half of a split in a roomy window: the row still fits the window,
    // so it stays a row. Passing the board width here is what used to flip it.
    expect(toolbarAxis("docked", 0, 400, 1280, false, "row", 400)).toBe("row");
    expect(toolbarAxis("docked", 0, 400, 900, false, "row", 400)).toBe("row");
  });

  it("stays a row once the window can hold the row and both rails", () => {
    expect(toolbarAxis("docked", 0, 400, 800, false, "row", 380)).toBe("row");
    expect(toolbarAxis("floating", 200, 48, 800, true, "row", 380)).toBe("row");
    expect(toolbarAxis("floating", 120, 280, 1024, false, "row", 380)).toBe("row");
  });

  it("becomes a column in a left or right edge band", () => {
    expect(toolbarAxis("floating", 8, 48, 1280, false, "row", 400)).toBe("column");
    expect(toolbarAxis("floating", 1280 - 56, 48, 1280, false, "row", 400)).toBe(
      "column",
    );
    expect(toolbarAxis("floating", 400, 400, 1280, false, "row", 400)).toBe("row");
  });

  it("uses hysteresis so the axis does not flicker at the band", () => {
    expect(toolbarAxis("floating", 100, 48, 1280, false, "column", 400)).toBe(
      "column",
    );
    expect(toolbarAxis("floating", 200, 48, 1280, false, "column", 400)).toBe("row");
  });
});

describe("toolbarWindowIsNarrow", () => {
  it("stays wide on a full-screen tablet", () => {
    expect(toolbarWindowIsNarrow(768, 380)).toBe(false);
    expect(toolbarWindowIsNarrow(1024, 380)).toBe(false);
  });

  it("counts the rails either side of the row, not just the row", () => {
    /*
     * The window off the phone-sized report: 450 CSS px holding a 350 px row.
     * The row *fits* — and still ran under the view stack, because the stack
     * and the annotate toggle each own a rail the row is laid out between.
     */
    expect(toolbarWindowIsNarrow(450, 350)).toBe(true);
    expect(toolbarWindowIsNarrow(484, 350)).toBe(true);
    expect(toolbarWindowIsNarrow(560, 350)).toBe(false);
  });

  it("keeps a longer row upright for longer", () => {
    expect(toolbarWindowIsNarrow(700, 380)).toBe(false);
    expect(toolbarWindowIsNarrow(700, 600)).toBe(true);
  });

  it("falls back to a nominal row before anything has been measured", () => {
    expect(toolbarWindowIsNarrow(1280, 0)).toBe(false);
    expect(toolbarWindowIsNarrow(400, 0)).toBe(true);
  });

  it("holds the column until the window clears the flip width", () => {
    expect(toolbarWindowIsNarrow(530, 380, "column")).toBe(true);
    expect(toolbarWindowIsNarrow(530, 380, "row")).toBe(false);
  });
});
