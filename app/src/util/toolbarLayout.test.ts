/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampToBox,
  loadToolbarLayout,
  saveToolbarLayout,
  TOOLBAR_DOCK_SNAP_PX,
  toolbarAxis,
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
    expect(toolbarAxis("docked", 0, 400, 1280, false)).toBe("row");
    expect(toolbarAxis("floating", 10, 48, 1280, true)).toBe("row");
  });

  it("becomes a column in a left or right edge band", () => {
    expect(toolbarAxis("floating", 8, 48, 1280, false)).toBe("column");
    expect(toolbarAxis("floating", 1280 - 56, 48, 1280, false)).toBe("column");
    expect(toolbarAxis("floating", 400, 400, 1280, false)).toBe("row");
  });

  it("uses hysteresis so the axis does not flicker at the band", () => {
    expect(toolbarAxis("floating", 100, 48, 1280, false, "column")).toBe("column");
    expect(toolbarAxis("floating", 200, 48, 1280, false, "column")).toBe("row");
  });
});
