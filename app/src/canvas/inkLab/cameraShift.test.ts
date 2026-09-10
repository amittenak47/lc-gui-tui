import { describe, expect, it } from "vitest";

import {
  canShiftPaintedSnap,
  exposedShiftRects,
  shiftClearsSnap,
  shiftSpineDots,
  snapShiftDevicePx,
  spineHitsRects,
  spineRunsInRects,
} from "./cameraShift";
import type { SpineDot } from "./instance";

const painted = {
  scrollX: 0,
  scrollY: 10,
  zoom: 1,
  width: 400,
  height: 600,
  marginY: 100,
};

describe("camera snap shift", () => {
  it("allows a pan that keeps zoom and backing size", () => {
    expect(
      canShiftPaintedSnap(painted, { ...painted, scrollY: 40 }),
    ).toBe(true);
  });

  it("refuses a pinch or a resize", () => {
    expect(canShiftPaintedSnap(painted, { ...painted, zoom: 1.2 })).toBe(false);
    expect(canShiftPaintedSnap(painted, { ...painted, height: 601 })).toBe(false);
    expect(canShiftPaintedSnap(painted, { ...painted, marginY: 80 })).toBe(false);
  });

  it("converts a scroll delta into device pixels", () => {
    expect(snapShiftDevicePx(painted, { ...painted, scrollY: 40 }, 2)).toEqual({
      dx: 0,
      dy: 60,
    });
    expect(
      snapShiftDevicePx(
        { scrollX: 0, scrollY: 0, zoom: 2 },
        { scrollX: 0, scrollY: 10, zoom: 2 },
        1,
      ),
    ).toEqual({ dx: 0, dy: 20 });
  });

  it("exposes the leading strip and refuses a full-canvas jump", () => {
    expect(exposedShiftRects(100, 80, 0, 12)).toEqual([
      { x: 0, y: 0, w: 100, h: 12 },
    ]);
    expect(exposedShiftRects(100, 80, 0, -12)).toEqual([
      { x: 0, y: 68, w: 100, h: 12 },
    ]);
    expect(shiftClearsSnap(100, 80, 0, 80)).toBe(true);
    expect(shiftClearsSnap(100, 80, 0, 12)).toBe(false);
  });

  it("slides overlay dots by the same delta as the bitmap", () => {
    const strokes: SpineDot[][] = [[{ x: 8, y: 10, r: 2 }]];
    shiftSpineDots(strokes, 0, 15);
    expect(strokes[0]![0]).toMatchObject({ x: 8, y: 25, r: 2 });
  });

  it("only redraws strokes that enter the new strip", () => {
    const kept: SpineDot[] = [{ x: 20, y: 40, r: 2 }];
    const entering: SpineDot[] = [{ x: 20, y: 4, r: 2 }];
    const strip = [{ x: 0, y: 0, w: 100, h: 12 }];
    expect(spineHitsRects(kept, strip)).toBe(false);
    expect(spineHitsRects(entering, strip)).toBe(true);
  });

  it("extracts only local runs from a page-covering spine", () => {
    const stroke: SpineDot[] = [];
    for (let y = 0; y <= 1000; y += 10) stroke.push({ x: 20, y, r: 2 });
    const runs = spineRunsInRects(stroke, [{ x: 0, y: 490, w: 100, h: 20 }]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.length).toBeLessThan(10);
    expect(runs[0]![0]!.y).toBeLessThanOrEqual(490);
    expect(runs[0]!.at(-1)!.y).toBeGreaterThanOrEqual(510);
  });

  it("keeps disjoint strip crossings as separate runs", () => {
    const stroke: SpineDot[] = [
      { x: 10, y: 5, r: 1 },
      { x: 20, y: 30, r: 1 },
      { x: 30, y: 60, r: 1 },
      { x: 40, y: 5, r: 1 },
    ];
    const runs = spineRunsInRects(stroke, [{ x: 0, y: 0, w: 100, h: 10 }]);
    expect(runs).toHaveLength(2);
  });
});
