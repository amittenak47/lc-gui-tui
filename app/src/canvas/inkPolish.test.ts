import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";

import {
  LIVE_GEOM_WINDOW,
  liveRibbonFence,
  liveRibbonStats,
  prepareLiveRibbon,
  releaseLiveRibbonBuffers,
  type ScenePoint,
} from "./rasterInk";

beforeAll(() => {
  (globalThis as Record<string, unknown>).OffscreenCanvas = class {
    constructor(w: number, h: number) {
      return createCanvas(Math.max(1, w), Math.max(1, h)) as unknown as object;
    }
  };
});

function lineOp(n: number) {
  const points: ScenePoint[] = [];
  for (let i = 0; i < n; i++) {
    points.push({ x: i * 2, y: Math.sin(i / 8) * 12, pressure: 0.5, slowness: 1 });
  }
  return {
    kind: "draw" as const,
    color: "#1a1a1a",
    baseWidth: 4,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    speedInk: 0.7,
    speedBlotBlend: 0.8,
    speedFade: 1,
    points,
  };
}

describe("live geom window", () => {
  afterEach(() => {
    releaseLiveRibbonBuffers();
  });

  it("pins the slowness fence behind LIVE_GEOM_WINDOW", () => {
    const op = lineOp(LIVE_GEOM_WINDOW + 200);
    prepareLiveRibbon(op, 1);
    expect(liveRibbonFence()).toBe(200);
  });

  it("suffix-hits after the first full tessellation on a growing stroke", () => {
    Object.assign(liveRibbonStats, {
      suffixHits: 0,
      suffixMisses: 0,
      suffixRewinds: 0,
    });
    const all = lineOp(LIVE_GEOM_WINDOW + 120).points;
    const points = all.slice(0, 80);
    const op = { ...lineOp(80), points };
    prepareLiveRibbon(op, 1);
    for (let i = 80; i < all.length; i += 8) {
      points.push(...all.slice(i, i + 8));
      prepareLiveRibbon(op, 1);
    }
    expect(liveRibbonStats.suffixHits).toBeGreaterThan(liveRibbonStats.suffixMisses);
  });

  it("resets the fence on a new polyline", () => {
    prepareLiveRibbon(lineOp(800), 1);
    expect(liveRibbonFence()).toBeGreaterThan(200);
    prepareLiveRibbon(lineOp(40), 1);
    expect(liveRibbonFence()).toBe(0);
  });
});
