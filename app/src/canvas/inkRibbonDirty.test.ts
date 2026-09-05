import { describe, expect, it } from "vitest";

import {
  poolingDirtyFrom,
  ribbonGeomDirtyFrom,
  slownessDirtyFrom,
  type InkDrawOp,
  type ScenePoint,
} from "./rasterInk";

function lineOp(n: number, extras: Partial<InkDrawOp> = {}): InkDrawOp {
  const points: ScenePoint[] = [];
  for (let i = 0; i < n; i++) {
    points.push({ x: i * 2, y: 0, pressure: 0.5, slowness: 1 });
  }
  return {
    kind: "draw",
    color: "#111111",
    baseWidth: 5,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    speedInk: 1,
    speedBlotBlend: 0.9,
    speedFade: 1,
    points,
    ...extras,
  };
}

describe("slownessDirtyFrom", () => {
  it("rebuilds when there is no previous track", () => {
    expect(slownessDirtyFrom(null, new Float32Array([1, 1, 1]))).toBe(0);
  });

  it("returns the first changed index, not the whole polyline", () => {
    const prev = new Float32Array(80);
    const next = new Float32Array(80);
    prev.fill(1);
    next.fill(1);
    next[70] = 1.4;
    expect(slownessDirtyFrom(prev, next)).toBe(70);
  });
});

describe("ribbonGeomDirtyFrom", () => {
  it("keeps the frontier near the tip on a long growing stroke", () => {
    const op = lineOp(400);
    const first = ribbonGeomDirtyFrom(op, null);
    expect(first.dirtyFrom).toBe(0);
    op.points.push({ x: 800, y: 0, pressure: 0.5, slowness: 1.2 });
    const second = ribbonGeomDirtyFrom(op, first.next);
    expect(second.dirtyFrom).toBeGreaterThan(100);
  });

  it("pulls the frontier back when a blotHalt lands in the prefix", () => {
    const op = lineOp(400);
    const first = ribbonGeomDirtyFrom(op, null);
    op.points.push({ x: 800, y: 0, pressure: 0.5, slowness: 1 });
    const growing = ribbonGeomDirtyFrom(op, first.next);
    expect(growing.dirtyFrom).toBeGreaterThan(100);

    op.blotHalts = [{ x: 80, y: 0, grow: 1, pressure: 0.6 }];
    const halted = ribbonGeomDirtyFrom(op, growing.next);
    expect(halted.dirtyFrom).toBeLessThan(80);
  });

  it("keeps the frontier near the tip on a looping scribble", () => {
    const points: ScenePoint[] = [];
    for (let i = 0; i < 50; i++) {
      points.push({
        x: 200 + Math.cos(i / 8) * 60,
        y: 200 + Math.sin(i / 8) * 40,
        pressure: 0.5,
        slowness: 1,
      });
    }
    const op: InkDrawOp = {
      kind: "draw",
      color: "#111111",
      baseWidth: 5,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 0.9,
      speedFade: 1,
      points,
    };
    let prev = ribbonGeomDirtyFrom(op, null).next;
    for (let i = 50; i < 400; i++) {
      points.push({
        x: 200 + Math.cos(i / 8) * 60,
        y: 200 + Math.sin(i / 8) * 40,
        pressure: 0.5,
        slowness: 1,
      });
      const next = ribbonGeomDirtyFrom(op, prev);
      prev = next.next;
      if (i === 399) {
        expect(next.dirtyFrom).toBeGreaterThan(points.length - 80);
      }
    }
  });
});

describe("poolingDirtyFrom", () => {
  it("a mid-stroke halt dirties near that halt, not only the tip", () => {
    const op = lineOp(200, {
      blotHalts: [{ x: 40, y: 0, grow: 1, pressure: 0.6 }],
    });
    const none = poolingDirtyFrom(op, null);
    expect(none.dirtyFrom).toBeLessThan(40);
    const again = poolingDirtyFrom(op, none.next);
    expect(again.dirtyFrom).toBeGreaterThan(100);
  });
});
