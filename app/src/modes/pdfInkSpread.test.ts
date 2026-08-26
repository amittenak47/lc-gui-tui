import { describe, expect, it } from "vitest";

import { pdfStackFrames } from "./PdfDocument";
import {
  locatePdfInkPoint,
  pdfLayoutIsSpread,
  remapInkBetweenPdfLayouts,
} from "./pdfInkSpread";
import type { InkOp } from "../canvas/rasterInk";

function draw(points: { x: number; y: number }[]): InkOp {
  return {
    kind: "draw",
    color: "#000",
    baseWidth: 2,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: points.map((p) => ({ ...p, pressure: 0.5 })),
  };
}

const oneUp = pdfStackFrames([{ pageNumber: 1, height: 100 }], false, 18, 0);
const twoUp = pdfStackFrames([{ pageNumber: 1, height: 200 }], true, 18, 0);

describe("pdfLayoutIsSpread", () => {
  it("is two frames of the same page id", () => {
    expect(pdfLayoutIsSpread(oneUp)).toBe(false);
    expect(pdfLayoutIsSpread(twoUp)).toBe(true);
  });
});

describe("locatePdfInkPoint", () => {
  it("splits a one-up sheet on the vertical gutter", () => {
    const left = locatePdfInkPoint(40, 40, oneUp, 0, 200);
    const right = locatePdfInkPoint(150, 40, oneUp, 0, 200);
    expect(left?.half).toBe("left");
    expect(right?.half).toBe("right");
    expect(left?.pageId).toBe(1);
  });
});

describe("remapInkBetweenPdfLayouts", () => {
  it("moves right-half ink onto the lower slot when spread turns on", () => {
    const ops = [draw([{ x: 150, y: 40 }])];
    const next = remapInkBetweenPdfLayouts(ops, oneUp, twoUp, 0, 200);
    expect(next).toHaveLength(1);
    const p = next[0]!.points[0]!;
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeGreaterThan(200);
    expect(p.y).toBeCloseTo(218 + 80);
  });

  it("scales left-half ink onto the upper slot", () => {
    const ops = [draw([{ x: 50, y: 40 }])];
    const next = remapInkBetweenPdfLayouts(ops, oneUp, twoUp, 0, 200);
    expect(next[0]!.points[0]!.x).toBeCloseTo(100);
    expect(next[0]!.points[0]!.y).toBeCloseTo(80);
  });

  it("splits a stroke that crossed the two book pages", () => {
    const ops = [draw([{ x: 40, y: 40 }, { x: 160, y: 40 }])];
    const next = remapInkBetweenPdfLayouts(ops, oneUp, twoUp, 0, 200);
    expect(next).toHaveLength(2);
    expect(next[0]!.points).toHaveLength(1);
    expect(next[1]!.points).toHaveLength(1);
    expect(next[0]!.points[0]!.y).toBeLessThan(200);
    expect(next[1]!.points[0]!.y).toBeGreaterThan(200);
  });

  it("round-trips a left-half point back onto the one-up sheet", () => {
    const ops = [draw([{ x: 50, y: 40 }])];
    const spread = remapInkBetweenPdfLayouts(ops, oneUp, twoUp, 0, 200);
    const back = remapInkBetweenPdfLayouts(spread, twoUp, oneUp, 0, 200);
    expect(back[0]!.points[0]!.x).toBeCloseTo(50);
    expect(back[0]!.points[0]!.y).toBeCloseTo(40);
  });

  it("does not rewrite ink when both layouts are one-up", () => {
    const ops = [draw([{ x: 50, y: 40 }])];
    const next = remapInkBetweenPdfLayouts(ops, oneUp, oneUp, 0, 200);
    expect(next[0]!.points[0]).toEqual(ops[0]!.points[0]);
  });
});
