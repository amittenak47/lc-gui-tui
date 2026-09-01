import { describe, expect, it } from "vitest";

import {
  LIVE_STROKE_PROMOTE_NIBS,
  LIVE_STROKE_TAIL_NIBS,
  LiveStrokeSurface,
  liveStrokeTailStart,
  shouldPromoteLiveStroke,
} from "./liveStrokeSurface";
import { NO_PRESSURE, type ScenePoint } from "./rasterInk";

function line(count: number, step = 1): ScenePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    x: i * step,
    y: 0,
    pressure: NO_PRESSURE,
  }));
}

describe("bounded live stroke window", () => {
  it("keeps ordinary short strokes on the exact full-paint path", () => {
    expect(liveStrokeTailStart(line(10), 2)).toBe(0);
  });

  it("bounds the mutable tail by nib travel rather than sample count", () => {
    const sparse = line(100, 2);
    const dense = line(400, 0.5);
    const sparseStart = liveStrokeTailStart(sparse, 2);
    const denseStart = liveStrokeTailStart(dense, 2);
    const tailTravel = (points: ScenePoint[], start: number) =>
      points[points.length - 1]!.x - points[start]!.x;
    expect(tailTravel(sparse, sparseStart)).toBeGreaterThanOrEqual(2 * LIVE_STROKE_TAIL_NIBS);
    expect(tailTravel(dense, denseStart)).toBeGreaterThanOrEqual(2 * LIVE_STROKE_TAIL_NIBS);
    expect(sparse.length - sparseStart).toBeLessThan(dense.length - denseStart);
  });

  it("promotes only after a useful settled chunk has accumulated", () => {
    const points = line(300, 2);
    const nib = 2;
    const first = 40;
    expect(shouldPromoteLiveStroke(points, nib, 0, first)).toBe(true);
    expect(shouldPromoteLiveStroke(points, nib, first, first + LIVE_STROKE_PROMOTE_NIBS - 1)).toBe(false);
    expect(shouldPromoteLiveStroke(points, nib, first, first + LIVE_STROKE_PROMOTE_NIBS)).toBe(true);
  });

  it("keeps painter ranges bounded while the canonical point list grows", () => {
    const context = {
      setTransform() {},
      clearRect() {},
      drawImage() {},
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
    } as unknown as CanvasRenderingContext2D;
    const factory = () =>
      ({
        width: 0,
        height: 0,
        getContext: () => context,
      }) as unknown as HTMLCanvasElement;
    const surface = new LiveStrokeSurface(factory);
    const pts = line(2, 2);
    const op = {
      kind: "draw" as const,
      color: "#000",
      baseWidth: 2,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      points: pts,
    };
    let largestRange = 0;
    const painter = (_ctx: CanvasRenderingContext2D, from: number, to: number) => {
      largestRange = Math.max(largestRange, to - from);
      return { alpha: 1, composite: "source-over" as const };
    };

    for (let i = 2; i < 5000; i += 1) {
      pts.push({ x: i * 2, y: Math.sin(i / 9), pressure: NO_PRESSURE });
      surface.paint(op, 2, 800, 600, painter);
    }

    expect(op.points).toHaveLength(5000);
    expect(surface.settledPointCount).toBeGreaterThan(4000);
    // 32-nib tail plus at most one 16-nib not-yet-promoted chunk.
    expect(largestRange).toBeLessThanOrEqual(52);
  });
});
