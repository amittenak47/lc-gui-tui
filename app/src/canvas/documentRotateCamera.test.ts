import { describe, expect, it } from "vitest";

import {
  documentCameraAfterViewportChange,
  DRAW_PAGE_REF_VIEW_W,
  excalidrawViewportNeedsSync,
  keepZoomCenterCameraAfterViewportChange,
  keepZoomKeepPanCameraAfterViewportChange,
  drawPageCameraAfterViewportChange,
  drawPageFitBox,
  drawPageRecentreCamera,
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

describe("keepZoomCenterCameraAfterViewportChange", () => {
  const page = { minX: 0, minY: 0, maxX: 3920, maxY: 4200 };

  it("keeps zoom and centers X when the pane grows", () => {
    const thin = keepZoomCenterCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 390,
      prevZoom: 0.1,
      prevScrollY: -200,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    const wide = keepZoomCenterCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 844,
      prevZoom: thin.zoom,
      prevScrollY: thin.scrollY,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    expect(wide.zoom).toBeCloseTo(thin.zoom, 5);
    const availW = 844 - inset.left - inset.right;
    const slack = availW - 3920 * wide.zoom;
    expect(slack).toBeGreaterThan(100);
    expect(wide.scrollX).toBeCloseTo((inset.left + slack / 2) / wide.zoom, 5);
  });

  it("zooms out when the pane is too narrow for the kept zoom", () => {
    const camera = keepZoomCenterCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 250,
      prevZoom: 0.2,
      prevScrollY: 0,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    const availW = 250 - inset.left - inset.right;
    expect(camera.zoom).toBeCloseTo(availW / 3920, 5);
    expect(3920 * camera.zoom).toBeLessThanOrEqual(availW + 0.5);
  });

  it("keeps the same scene line at the top of the hole", () => {
    const first = keepZoomCenterCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 390,
      prevZoom: 0.1,
      prevScrollY: -480,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    const sceneYTop = inset.top / first.zoom - first.scrollY;
    const next = keepZoomCenterCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 844,
      prevZoom: first.zoom,
      prevScrollY: first.scrollY,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    expect(inset.top / next.zoom - next.scrollY).toBeCloseTo(sceneYTop, 5);
  });
});

describe("drawPageFitBox", () => {
  const page = { minX: 0, minY: 10, maxX: 800, maxY: 4200 };

  it("keeps the authored sheet width so the camera does not zoom into the ink", () => {
    const box = drawPageFitBox(page, { minX: 400 }, 3920);
    expect(box.minX).toBe(0);
    expect(box.maxX).toBe(3920);
    expect(box.minY).toBe(10);
  });

  it("zooms out when writing starts before the frame so the right of the sheet stays on screen", () => {
    const box = drawPageFitBox(page, { minX: -80 }, 3920);
    expect(box.minX).toBe(-80);
    expect(box.maxX).toBe(3920);
  });

  it("zooms out when writing runs past the sheet", () => {
    const box = drawPageFitBox(page, { minX: 0, maxX: 4100 }, 3920);
    expect(box.minX).toBe(0);
    expect(box.maxX).toBe(4100);
  });
});

describe("drawPageCameraAfterViewportChange", () => {
  const page = { minX: 0, minY: 0, maxX: 3920, maxY: 4200 };

  it("scales writing with the window and pins the page to the left", () => {
    const tablet = drawPageCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 390,
      prevZoom: 0.1,
      prevScrollY: -200,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    const desktop = drawPageCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 844,
      prevZoom: tablet.zoom,
      prevScrollY: tablet.scrollY,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    expect(desktop.zoom).toBeGreaterThan(tablet.zoom);
    const tabletAvail = 390 - inset.left - inset.right;
    const desktopAvail = 844 - inset.left - inset.right;
    expect(tablet.zoom).toBeCloseTo(tabletAvail / 3920, 5);
    expect(desktop.zoom).toBeCloseTo(desktopAvail / 3920, 5);
    expect(inset.left / tablet.zoom - tablet.scrollX).toBeCloseTo(0, 5);
    expect(inset.left / desktop.zoom - desktop.scrollX).toBeCloseTo(0, 5);
  });

  it("fills a desktop window instead of letterboxing a tablet hole", () => {
    const tablet = drawPageCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: DRAW_PAGE_REF_VIEW_W,
      prevZoom: 1,
      prevScrollY: -200,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    const desktop = drawPageCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 1800,
      prevZoom: tablet.zoom,
      prevScrollY: tablet.scrollY,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    const desktopAvail = 1800 - inset.left - inset.right;
    expect(desktop.zoom).toBeGreaterThan(tablet.zoom);
    expect(desktop.zoom).toBeCloseTo(desktopAvail / 3920, 5);
    expect(inset.left / desktop.zoom - desktop.scrollX).toBeCloseTo(0, 5);
  });

  it("still honours an explicit fit cap when a caller asks for one", () => {
    const desktop = drawPageCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 1800,
      prevZoom: 1,
      prevScrollY: 0,
      zoomMin: 0.02,
      zoomMax: 1.75,
      capViewWidth: DRAW_PAGE_REF_VIEW_W,
    });
    expect(desktop.zoom).toBeCloseTo(DRAW_PAGE_REF_VIEW_W / 3920, 5);
  });

  it("still scales down when the window is narrower than the tablet hole", () => {
    const wide = drawPageCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 844,
      prevZoom: 0.4,
      prevScrollY: 0,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    const thin = drawPageCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 250,
      prevZoom: wide.zoom,
      prevScrollY: wide.scrollY,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    expect(thin.zoom).toBeLessThan(wide.zoom);
    const availW = 250 - inset.left - inset.right;
    expect(3920 * thin.zoom).toBeLessThanOrEqual(availW + 0.5);
    expect(inset.left / thin.zoom - thin.scrollX).toBeCloseTo(0, 5);
  });

  it("keeps the same scene line at the top of the hole", () => {
    const first = drawPageCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 390,
      prevZoom: 0.1,
      prevScrollY: -480,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    const sceneYTop = inset.top / first.zoom - first.scrollY;
    const next = drawPageCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 844,
      prevZoom: first.zoom,
      prevScrollY: first.scrollY,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    expect(inset.top / next.zoom - next.scrollY).toBeCloseTo(sceneYTop, 5);
  });

  it("stays left-aligned when zoom hits the cap and leftover slack appears", () => {
    const camera = drawPageCameraAfterViewportChange({
      box: { minX: 0, minY: 0, maxX: 342, maxY: 4000 },
      inset,
      viewWidth: 844,
      prevZoom: 1,
      prevScrollY: 0,
      zoomMin: 0.15,
      zoomMax: 1.75,
    });
    expect(camera.zoom).toBe(1.75);
    expect(inset.left / camera.zoom - camera.scrollX).toBeCloseTo(0, 5);
  });
});

describe("keepZoomKeepPanCameraAfterViewportChange", () => {
  const page = { minX: 0, minY: 0, maxX: 3920, maxY: 4200 };

  it("keeps the saved pan when zoom still fits", () => {
    const next = keepZoomKeepPanCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 844,
      prevZoom: 0.1,
      prevScrollX: -1200,
      prevScrollY: -400,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    expect(next.zoom).toBe(0.1);
    expect(next.scrollX).toBeCloseTo(-1200, 5);
    expect(next.scrollY).toBeCloseTo(-400, 5);
  });

  it("does not zoom in when the desktop hole is wider than the tablet", () => {
    const tabletZoom = 0.2;
    const next = keepZoomKeepPanCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 1800,
      prevZoom: tabletZoom,
      prevScrollX: 0,
      prevScrollY: -120,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    expect(next.zoom).toBe(tabletZoom);
    expect(next.zoom).toBeLessThan((1800 - inset.left - inset.right) / 3920);
    expect(next.scrollY).toBeCloseTo(-120, 5);
  });

  it("keeps the same scene point when it has to zoom out", () => {
    const prevZoom = 0.5;
    const prevScrollX = -800;
    const sceneXLeft = inset.left / prevZoom - prevScrollX;
    const next = keepZoomKeepPanCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 250,
      prevZoom,
      prevScrollX,
      prevScrollY: -200,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    expect(next.zoom).toBeLessThan(prevZoom);
    expect(inset.left / next.zoom - next.scrollX).toBeCloseTo(sceneXLeft, 5);
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

describe("the split-pane fit floor", () => {
  /*
   * A scratch page is 3920 scene units wide. The thin half of a split in a
   * window the size of a tablet is ~250 CSS px, which wants 0.06 — under the
   * 0.15 floor a *pinch* is held to. Handing the fit that floor is what drew
   * the page two and a half times too big and pushed its right edge past the
   * sash; the fit gets its own, much lower, floor now.
   */
  const page = { minX: 0, minY: 0, maxX: 3920, maxY: 4200 };

  it("fits a scratch page into a thin split pane", () => {
    const camera = documentCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 250,
      prevZoom: 1,
      prevScrollY: 0,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    const availW = 250 - inset.left - inset.right;
    expect(camera.zoom).toBeCloseTo(availW / 3920, 5);
    // The whole page width lands inside the hole — nothing past either edge.
    expect(3920 * camera.zoom).toBeLessThanOrEqual(availW + 0.5);
  });

  it("is the floor that used to cut the page off", () => {
    const clamped = documentCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 250,
      prevZoom: 1,
      prevScrollY: 0,
      zoomMin: 0.15,
      zoomMax: 1.75,
    });
    expect(clamped.zoom).toBe(0.15);
    expect(3920 * clamped.zoom).toBeGreaterThan(250);
  });

  it("leaves a roomy pane alone — the floor never binds there", () => {
    const camera = documentCameraAfterViewportChange({
      box: page,
      inset,
      viewWidth: 768,
      prevZoom: 1,
      prevScrollY: 0,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    expect(camera.zoom).toBeGreaterThan(0.15);
  });
});

describe("drawPageRecentreCamera", () => {
  const page = { minX: 0, minY: 0, maxX: 3920, maxY: 4200 };

  it("width-fits about the hole centre instead of slamming to the left edge", () => {
    const viewWidth = 844;
    const availW = viewWidth - inset.left - inset.right;
    const prevZoom = 0.8;
    const prevScrollX = (viewWidth - inset.right) / prevZoom - page.maxX;
    const next = drawPageRecentreCamera({
      box: page,
      inset,
      viewWidth,
      prevZoom,
      prevScrollX,
      prevScrollY: -200,
      zoomMin: 0.02,
      zoomMax: 1.75,
    });
    expect(next.zoom).toBeCloseTo(availW / 3920, 5);
    const holeCenter = inset.left + availW / 2;
    expect(holeCenter / next.zoom - next.scrollX).toBeCloseTo(
      holeCenter / prevZoom - prevScrollX,
      5,
    );
    const startAlignX = inset.left / next.zoom - page.minX;
    expect(next.scrollX).not.toBeCloseTo(startAlignX, 3);
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
