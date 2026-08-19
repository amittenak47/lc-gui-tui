import { describe, expect, it } from "vitest";

import {
  documentCameraAfterViewportChange,
  excalidrawViewportNeedsSync,
  liveBoardViewSize,
  liveExcalidrawViewport,
} from "./documentRotateCamera";

const inset = { top: 6, left: 2, right: 2, bottom: 12 };
const box = { minX: 0, minY: 0, maxX: 342, maxY: 4000 };

describe("documentCameraAfterViewportChange", () => {
  it("centers X when zoom hits the cap and leftover slack appears", () => {
    const prev = documentCameraAfterViewportChange({
      box,
      inset,
      viewWidth: 390,
      prevZoom: 1,
      prevScrollY: 0,
      zoomMin: 0.15,
      zoomMax: 1.75,
    });
    const next = documentCameraAfterViewportChange({
      box,
      inset,
      viewWidth: 844,
      prevZoom: prev.zoom,
      prevScrollY: prev.scrollY,
      zoomMin: 0.15,
      zoomMax: 1.75,
    });
    expect(next.zoom).toBe(1.75);
    const availW = 844 - 2 - 2;
    const painted = 342 * next.zoom;
    const slack = availW - painted;
    expect(slack).toBeGreaterThan(100);
    expect(next.scrollX).toBeCloseTo((2 + slack / 2) / next.zoom, 5);
  });

  it("keeps the same scene line at the top of the hole after rotate", () => {
    const portrait = documentCameraAfterViewportChange({
      box,
      inset,
      viewWidth: 390,
      prevZoom: 1,
      prevScrollY: 0,
      zoomMin: 0.15,
      zoomMax: 1.75,
    });
    const scrolledY = portrait.scrollY - 480;
    const sceneYTop = inset.top / portrait.zoom - scrolledY;
    const landscape = documentCameraAfterViewportChange({
      box,
      inset,
      viewWidth: 844,
      prevZoom: portrait.zoom,
      prevScrollY: scrolledY,
      zoomMin: 0.15,
      zoomMax: 1.75,
    });
    const sceneYTopAfter = inset.top / landscape.zoom - landscape.scrollY;
    expect(sceneYTopAfter).toBeCloseTo(sceneYTop, 5);
  });

  it("does not jump a page that was already at the top", () => {
    const portrait = documentCameraAfterViewportChange({
      box,
      inset,
      viewWidth: 390,
      prevZoom: 1,
      prevScrollY: 0,
      zoomMin: 0.15,
      zoomMax: 1.75,
    });
    const landscape = documentCameraAfterViewportChange({
      box,
      inset,
      viewWidth: 844,
      prevZoom: portrait.zoom,
      prevScrollY: portrait.scrollY,
      zoomMin: 0.15,
      zoomMax: 1.75,
    });
    const before = inset.top / portrait.zoom - portrait.scrollY;
    const after = inset.top / landscape.zoom - landscape.scrollY;
    expect(after).toBeCloseTo(before, 5);
  });
});

describe("liveBoardViewSize", () => {
  it("prefers the live board box over a larger stale appState (portrait after landscape)", () => {
    const size = liveBoardViewSize({ width: 800, height: 1200 }, { width: 1280, height: 800 });
    expect(size.viewWidth).toBe(800);
    expect(size.viewHeight).toBe(1200);
  });

  it("prefers a split pane box over a stale full-width appState", () => {
    const size = liveBoardViewSize({ width: 390, height: 800 }, { width: 844, height: 800 });
    expect(size.viewWidth).toBe(390);
    expect(size.viewHeight).toBe(800);
  });

  it("uses appState when the board box is not laid out yet", () => {
    const size = liveBoardViewSize({ width: 0, height: 0 }, { width: 390, height: 844 });
    expect(size.viewWidth).toBe(390);
    expect(size.viewHeight).toBe(844);
  });
});

describe("liveExcalidrawViewport", () => {
  it("returns null until the board has a real box", () => {
    expect(liveExcalidrawViewport(null)).toBeNull();
    expect(liveExcalidrawViewport({ width: 0, height: 800 })).toBeNull();
  });

  it("rounds the live board box", () => {
    expect(liveExcalidrawViewport({ width: 389.6, height: 800.2 })).toEqual({
      width: 390,
      height: 800,
    });
  });

  it("needs a sync when appState is still the full window", () => {
    const live = liveExcalidrawViewport({ width: 390, height: 800 });
    expect(live).not.toBeNull();
    expect(excalidrawViewportNeedsSync(live!, { width: 844, height: 800 })).toBe(true);
    expect(excalidrawViewportNeedsSync(live!, { width: 390, height: 800 })).toBe(false);
  });
});
