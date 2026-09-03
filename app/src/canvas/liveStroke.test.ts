import { afterEach, describe, expect, it, vi } from "vitest";

import { beginLiveStroke } from "./liveStroke";
import { INK_SMOOTHING_MODE_DEFAULT } from "./inkSmoothing";

function rect(width = 200, height = 200): DOMRectReadOnly {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON() {
      return {};
    },
  };
}

function view() {
  return {
    zoom: 1,
    scrollX: 0,
    scrollY: 0,
    offsetLeft: 0,
    offsetTop: 0,
    width: 200,
    height: 200,
  };
}

function sample(
  x: number,
  y: number,
  timeStamp: number,
  pressure = 0.5,
): {
  clientX: number;
  clientY: number;
  pressure: number;
  timeStamp: number;
  pointerType: string;
} {
  return { clientX: x, clientY: y, pressure, timeStamp, pointerType: "pen" };
}

function beginPen(onNeedPaint = () => {}) {
  return beginLiveStroke({
    tool: "pen",
    view: view(),
    rect: rect(),
    box: { width: 200, height: 200, marginY: 0 },
    first: sample(10, 10, 1000, 0.4),
    color: "#111111",
    uiWidth: 4,
    inkFullness: 0.8,
    pressureClip: 1,
    pressureSensitive: false,
    speedInk: 0,
    speedBlotBlend: 0,
    speedFade: 0,
    grain: 0,
    boldness: 1,
    smoothing: 0,
    smoothingMode: INK_SMOOTHING_MODE_DEFAULT,
    getStraightAnchor: () => null,
    host: null,
    onNeedPaint,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LiveStroke scaffold", () => {
  it("keeps every dense sample on the spine (step-2 1:1 drain)", () => {
    const stroke = beginPen();
    const hops = 20;
    const points = [];
    for (let i = 1; i <= hops; i += 1) {
      // Far enough to leave the contact disc, still closer than a stamp step.
      points.push(sample(10 + i * 2, 10, 1000 + i * 2));
    }
    stroke.ingest(points);
    stroke.tick(1040);
    const op = stroke.commit();
    expect(op.kind).toBe("draw");
    if (op.kind !== "draw") return;
    // stampAlongSegment returns [to] when dist < step, so the spine grows
    // with the digitizer, not with travel.
    expect(op.points[op.points.length - 1]?.x).toBeCloseTo(10 + hops * 2, 5);
    // Contact-disc collapse can eat the first hop; after that each dense
    // sample is kept (stampAlongSegment returns [to] when dist < step).
    expect(op.points.length).toBeGreaterThanOrEqual(hops);
    expect(op.points.length).toBeLessThanOrEqual(1 + hops);
  });

  it("commits samples that were ingested after the last tick", () => {
    const stroke = beginPen();
    stroke.ingest([sample(40, 10, 1100)]);
    const op = stroke.commit();
    expect(op.kind).toBe("draw");
    if (op.kind !== "draw") return;
    expect(op.points.length).toBeGreaterThan(1);
    expect(op.points[op.points.length - 1]?.x).toBeCloseTo(40, 5);
  });

  it("abandon stops dwell and drops the live op", () => {
    const onNeedPaint = vi.fn();
    const stroke = beginLiveStroke({
      tool: "pen",
      view: view(),
      rect: rect(),
      box: { width: 200, height: 200, marginY: 0 },
      first: sample(10, 10, 1000),
      color: "#111111",
      uiWidth: 4,
      inkFullness: 0.8,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 1,
      speedFade: 1,
      grain: 0,
      boldness: 1,
      smoothing: 0,
      smoothingMode: INK_SMOOTHING_MODE_DEFAULT,
      getStraightAnchor: () => null,
      host: null,
      onNeedPaint,
    });
    stroke.abandon();
    expect(stroke.live).toBeNull();
    stroke.ingest([sample(20, 10, 1100)]);
    stroke.tick(1200);
    expect(stroke.live).toBeNull();
  });
});
