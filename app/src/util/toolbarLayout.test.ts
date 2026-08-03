/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import {
  loadToolbarLayout,
  saveToolbarLayout,
  TOOLBAR_DOCK_SNAP_PX,
} from "./toolbarLayout";

const KEY = "lc.toolbar.layout.v1";

afterEach(() => {
  localStorage.removeItem(KEY);
});

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
