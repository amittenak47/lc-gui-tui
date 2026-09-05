import { afterEach, describe, expect, it, vi } from "vitest";

import { beginLiveStroke, DiscExtentTracker } from "./liveStroke";
import { INK_SMOOTHING_MODE_DEFAULT } from "./inkSmoothing";
import { isDiscPrimaryPath, type ScenePoint } from "./rasterInk";

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

function view(zoom = 1) {
  return {
    zoom,
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

function beginPen(
  extras: {
    pressureSensitive?: boolean;
    speedInk?: number;
    speedBlotBlend?: number;
    zoom?: number;
    onNeedPaint?: () => void;
  } = {},
) {
  const blot = extras.speedBlotBlend ?? (extras.speedInk ? 1 : 0);
  return beginLiveStroke({
    tool: "pen",
    view: view(extras.zoom ?? 1),
    rect: rect(),
    box: { width: 200, height: 200, marginY: 0 },
    first: sample(10, 10, 1000, 0.4),
    color: "#111111",
    uiWidth: 4,
    inkFullness: 0.8,
    pressureClip: 1,
    pressureSensitive: extras.pressureSensitive ?? false,
    speedInk: extras.speedInk ?? 0,
    speedBlotBlend: blot,
    speedFade: extras.speedInk ? 1 : 0,
    grain: 0,
    boldness: 1,
    smoothing: 0,
    smoothingMode: INK_SMOOTHING_MODE_DEFAULT,
    getStraightAnchor: () => null,
    host: null,
    onNeedPaint: extras.onNeedPaint ?? (() => {}),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DiscExtentTracker", () => {
  it("matches isDiscPrimaryPath without cloning the trail", () => {
    const origin: ScenePoint = { x: 0, y: 0, pressure: 0.5 };
    const nib = 4;
    const trail: ScenePoint[] = [origin];
    const disc = new DiscExtentTracker();
    disc.reset(origin);
    const hops: Array<[number, number]> = [
      [0.2, 0],
      [0.4, 0.1],
      [8, 0],
      [20, 1],
    ];
    for (const [x, y] of hops) {
      const next: ScenePoint = { x, y, pressure: 0.5 };
      const cloned = [...trail, next];
      expect(disc.wouldStayDisc(next, nib)).toBe(isDiscPrimaryPath(cloned, nib));
      if (!isDiscPrimaryPath(cloned, nib)) {
        trail.push(next);
        disc.commit(next);
      }
    }
  });
});

describe("LiveStroke ingest", () => {
  it("does not grow the spine with dense samples; the tip still tracks", () => {
    const stroke = beginPen();
    const hops = 80;
    const points = [];
    for (let i = 1; i <= hops; i += 1) {
      points.push(sample(10 + i * 0.2, 10, 1000 + i));
    }
    stroke.ingest(points);
    stroke.tick(1080);
    const live = stroke.live;
    expect(live?.kind).toBe("draw");
    if (live?.kind !== "draw") return;
    expect(live.points.length).toBeLessThan(hops / 4);
    expect(live.points[live.points.length - 1]?.x).toBeCloseTo(10 + hops * 0.2, 5);
    const livePts = live.points;
    const liveFirst = live.points[0];
    const op = stroke.commit();
    if (op.kind !== "draw") return;
    expect(op.points[op.points.length - 1]?.x).toBeCloseTo(10 + hops * 0.2, 5);
    expect(op.points.length).toBeLessThan(hops / 4);
    expect(op.points).not.toBe(livePts);
    expect(op.points[0]).not.toBe(liveFirst);
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

  it("attack flush of a planted nib stays a contact disc", () => {
    const stroke = beginPen({ pressureSensitive: true });
    stroke.ingest([
      sample(10.2, 10.1, 1004, 0.6),
      sample(10.1, 10.2, 1008, 0.7),
    ]);
    const op = stroke.commit();
    expect(op.kind).toBe("draw");
    if (op.kind !== "draw") return;
    const origin = op.points[0];
    expect(origin?.x).toBeCloseTo(10, 5);
    expect(origin?.y).toBeCloseTo(10, 5);
    for (const p of op.points) {
      expect(Math.hypot(p.x - 10, p.y - 10)).toBeLessThan(1);
    }
  });

  it("leaving the disc does not collapse the trail back to the origin", () => {
    const stroke = beginPen({ pressureSensitive: true });
    stroke.ingest([
      sample(10.1, 10, 1004, 0.5),
      sample(10.2, 10, 1008, 0.5),
      sample(80, 10, 1020, 0.5),
    ]);
    const op = stroke.commit();
    expect(op.kind).toBe("draw");
    if (op.kind !== "draw") return;
    expect(op.points.length).toBeGreaterThan(1);
    expect(op.points[op.points.length - 1]?.x).toBeCloseTo(80, 5);
    expect(op.points[0]?.x).toBeCloseTo(10, 5);
  });

  it("a long hop is one spine sample, not nib-step interpolation", () => {
    const stroke = beginPen({ speedInk: 1 });
    stroke.ingest([sample(120, 10, 1020, 0.5)]);
    stroke.tick(1020);
    const live = stroke.live;
    expect(live?.kind).toBe("draw");
    if (live?.kind !== "draw") return;
    expect(live.points.length).toBeLessThan(8);
    expect(live.points[live.points.length - 1]?.x).toBeCloseTo(120, 5);
    stroke.abandon();
  });

  it("a turning hop plants spine samples off the chord", () => {
    const stroke = beginPen({ speedInk: 1 });
    stroke.ingest([sample(80, 10, 1020, 0.5)]);
    stroke.tick(1020);
    stroke.ingest([sample(80, 80, 1040, 0.5)]);
    stroke.tick(1040);
    const live = stroke.live;
    expect(live?.kind).toBe("draw");
    if (live?.kind !== "draw") return;
    expect(live.points.length).toBeGreaterThan(3);
    const onLastHop = live.points.filter((p) => p.y > 12 && p.y < 78);
    expect(onLastHop.length).toBeGreaterThan(0);
    let off = 0;
    for (const p of onLastHop) off = Math.max(off, Math.abs(p.x - 80));
    expect(off).toBeGreaterThan(0.2);
    expect(live.points[live.points.length - 1]?.x).toBeCloseTo(80, 5);
    expect(live.points[live.points.length - 1]?.y).toBeCloseTo(80, 5);
    const liveLen = live.points.length;
    const committed = stroke.commit();
    if (committed.kind !== "draw") return;
    expect(committed.points.length).toBeGreaterThanOrEqual(liveLen);
    expect(committed.points[committed.points.length - 1]?.y).toBeCloseTo(80, 5);
  });

  it("abandon stops dwell and drops the live op", () => {
    const onNeedPaint = vi.fn();
    const stroke = beginPen({ speedInk: 1, onNeedPaint });
    stroke.abandon();
    expect(stroke.live).toBeNull();
    stroke.ingest([sample(20, 10, 1100)]);
    stroke.tick(1200);
    expect(stroke.live).toBeNull();
  });

  it("overlay dirty rect is a letter-sized box, not the full overlay", () => {
    const stroke = beginPen();
    stroke.ingest([sample(40, 12, 1100), sample(80, 14, 1120)]);
    stroke.tick(1120);
    const dirty = stroke.overlayDirtyPx(null, view(), 1);
    expect(dirty.w * dirty.h).toBeLessThan(200 * 200 * 0.5);
    expect(dirty.x + dirty.w).toBeLessThanOrEqual(200);
    expect(dirty.y + dirty.h).toBeLessThanOrEqual(200);
  });

  it("overlay dirty rect unions the previous box so leftover ink is restored", () => {
    const stroke = beginPen();
    stroke.ingest([sample(30, 10, 1100)]);
    stroke.tick(1100);
    const first = stroke.overlayDirtyPx(null, view(), 1);
    stroke.ingest([sample(120, 80, 1200)]);
    stroke.tick(1200);
    const next = stroke.overlayDirtyPx(first, view(), 1);
    expect(next.x).toBeLessThanOrEqual(first.x);
    expect(next.y).toBeLessThanOrEqual(first.y);
    expect(next.x + next.w).toBeGreaterThanOrEqual(first.x + first.w);
    expect(next.y + next.h).toBeGreaterThanOrEqual(first.y + first.h);
  });

  it("keeps the pool while a wiggle stays on the contact disc", () => {
    const stroke = beginPen({ speedBlotBlend: 0.9 });
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) stroke.tick(t0 + 80 + i * 32);
    const heldOp = stroke.live;
    expect(heldOp?.kind).toBe("draw");
    if (heldOp?.kind !== "draw") return;
    const held = heldOp.blotTipGrow ?? 0;
    expect(held).toBeGreaterThan(0.15);

    stroke.ingest([sample(12.5, 10, 4000)]);
    stroke.tick(t0 + 80 + 50 * 32 + 16);
    const still = stroke.live;
    expect(still?.kind).toBe("draw");
    if (still?.kind !== "draw") return;
    const origin = still.points[0]!;
    expect(
      still.points.every((p) => Math.hypot(p.x - origin.x, p.y - origin.y) < 4),
    ).toBe(true);
    expect(still.blotTipGrow ?? 0).toBeGreaterThanOrEqual(held - 1e-6);

    stroke.ingest([sample(90, 10, 4100)]);
    stroke.tick(t0 + 80 + 50 * 32 + 32);
    const gone = stroke.live;
    expect(gone?.kind).toBe("draw");
    if (gone?.kind !== "draw") return;
    expect(gone.blotTipGrow ?? 0).toBe(0);
    expect(gone.blotHalts?.[0]?.grow).toBeGreaterThanOrEqual(held - 1e-3);
    stroke.abandon();
  });

  it("does not thin the origin with speed ink while the contact disc still holds", () => {
    const stroke = beginPen({ speedInk: 1, speedBlotBlend: 0.9 });
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) stroke.tick(t0 + 80 + i * 32);
    const heldOp = stroke.live;
    expect(heldOp?.kind).toBe("draw");
    if (heldOp?.kind !== "draw") return;
    const heldSlow = heldOp.points[0]?.slowness ?? 0;
    expect(heldSlow).toBeGreaterThan(0.7);

    // dt ≈ 1ms over 2.5px is a flick, still inside one nib.
    stroke.ingest([sample(12.5, 10, 1001)]);
    stroke.tick(t0 + 80 + 50 * 32 + 16);
    const still = stroke.live;
    expect(still?.kind).toBe("draw");
    if (still?.kind !== "draw") return;
    expect(still.points[0]?.slowness ?? 0).toBeGreaterThanOrEqual(heldSlow - 1e-6);
    stroke.abandon();
  });
});
