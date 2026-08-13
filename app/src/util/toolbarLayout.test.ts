/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import {
  clampToBox,
  loadToolbarLayout,
  saveToolbarLayout,
  TOOLBAR_DOCK_SNAP_PX,
} from "./toolbarLayout";

const KEY = "lc.toolbar.layout.v1";

describe("toolbarLayout", () => {
  afterEach(() => {
    localStorage?.removeItem(KEY);
  });
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
