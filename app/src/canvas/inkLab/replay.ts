/**
 * Replay one pointer tape through perfect-freehand, Speed Ink stamp+bake, and
 * the Ink lab engine. WebGL2 is timed on the pad; Node uses the 2D fallback.
 */

import { createCanvas } from "@napi-rs/canvas";

function ensureOffscreenCanvas(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.OffscreenCanvas === "function") return;
  g.OffscreenCanvas = class {
    constructor(w: number, h: number) {
      return createCanvas(Math.max(1, w), Math.max(1, h)) as unknown as object;
    }
  };
}

import {
  fillFreehandOutline,
  freehandStrokeOptions,
} from "../../modes/FreehandLab";
import { getStroke } from "perfect-freehand";
import { expandInkTurns, type ScenePoint } from "../rasterInk";
import { INK_SMOOTHING_MODE_DEFAULT, smoothInkPoints } from "../inkSmoothing";
import { beginLiveStroke } from "../liveStroke";

import { createInkLabEngine, type InkLabSample } from "./engine";

export type TimingSummary = {
  n: number;
  p50: number;
  p95: number;
  lastMs: number;
  holdMs: number | null;
  outlineN: number;
  bakeMs: number | null;
};

export type InkLabTiming = TimingSummary & {
  backend: string;
  bake: string;
};

export type TapeReplay = {
  name: string;
  n: number;
  pf: TimingSummary;
  speedStamp: TimingSummary;
  speedBakeMs: number;
  ink2d: InkLabTiming;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

function summarize(
  frames: number[],
  n: number,
  extra: { lastMs: number; holdMs: number | null; outlineN: number; bakeMs: number | null },
): TimingSummary {
  const sorted = frames.slice().sort((a, b) => a - b);
  return {
    n,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    lastMs: extra.lastMs,
    holdMs: extra.holdMs,
    outlineN: extra.outlineN,
    bakeMs: extra.bakeMs,
  };
}

function pfInput(samples: readonly InkLabSample[]): number[][] {
  return samples.map((s) => [s.x, s.y, s.p]);
}

export function timePerfectFreehand(
  samples: readonly InkLabSample[],
  hold: boolean,
): TimingSummary {
  const canvas = createCanvas(800, 600);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = "#1a1a1a";
  const frames: number[] = [];
  const pts: number[][] = [];
  let outlineN = 0;
  for (const s of samples) {
    pts.push([s.x, s.y, s.p]);
    const t0 = performance.now();
    const outline = getStroke(pts, freehandStrokeOptions(false, false));
    outlineN = outline.length;
    fillFreehandOutline(ctx, outline);
    frames.push(performance.now() - t0);
  }
  const tLift = performance.now();
  const lastOutline = getStroke(pts, freehandStrokeOptions(true, false));
  fillFreehandOutline(ctx, lastOutline);
  const liftMs = performance.now() - tLift;
  return summarize(frames, samples.length, {
    lastMs: liftMs,
    holdMs: hold ? frames[frames.length - 1]! : null,
    outlineN: lastOutline.length,
    bakeMs: liftMs,
  });
}

function sceneOf(s: InkLabSample): ScenePoint {
  return { x: s.x, y: s.y, pressure: s.p };
}

export function timeSpeedBake(samples: readonly InkLabSample[]): number {
  const points = samples.map(sceneOf);
  const t0 = performance.now();
  const smoothed = smoothInkPoints(points, 0.35, 4);
  expandInkTurns(smoothed);
  return performance.now() - t0;
}

function rect(width: number, height: number): DOMRectReadOnly {
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

export function timeSpeedStamp(
  samples: readonly InkLabSample[],
  hold: boolean,
): TimingSummary {
  ensureOffscreenCanvas();
  if (samples.length === 0) {
    return summarize([], 0, { lastMs: 0, holdMs: null, outlineN: 0, bakeMs: 0 });
  }
  const w = 800;
  const h = 600;
  const overlay = createCanvas(w, h);
  const snap = createCanvas(w, h);
  const octx = overlay.getContext("2d");
  const first = samples[0]!;
  const stroke = beginLiveStroke({
    tool: "pen",
    view: {
      zoom: 1,
      scrollX: 0,
      scrollY: 0,
      offsetLeft: 0,
      offsetTop: 0,
      width: w,
      height: h,
    },
    rect: rect(w, h),
    box: { width: w, height: h, marginY: 0 },
    first: {
      clientX: first.x,
      clientY: first.y,
      pressure: first.p,
      timeStamp: first.t,
      pointerType: "pen",
    },
    color: "#111111",
    uiWidth: 4,
    inkFullness: 0.8,
    pressureClip: 1,
    pressureSensitive: true,
    speedInk: 1,
    speedBlotBlend: 1,
    speedFade: 1,
    grain: 0,
    boldness: 1,
    smoothing: 0,
    smoothingMode: INK_SMOOTHING_MODE_DEFAULT,
    getStraightAnchor: () => null,
    host: null,
    onNeedPaint: () => {},
  });
  const frames: number[] = [];
  stroke.tick(first.t);
  const tFirst = performance.now();
  stroke.paint(
    octx as unknown as CanvasRenderingContext2D,
    overlay as unknown as HTMLCanvasElement,
    1,
    null,
    new Map(),
    snap as unknown as HTMLCanvasElement,
  );
  frames.push(performance.now() - tFirst);
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!;
    stroke.ingest([
      {
        clientX: s.x,
        clientY: s.y,
        pressure: s.p,
        timeStamp: s.t,
        pointerType: "pen",
      },
    ]);
    stroke.tick(s.t);
    const t0 = performance.now();
    stroke.paint(
      octx as unknown as CanvasRenderingContext2D,
      overlay as unknown as HTMLCanvasElement,
      1,
      null,
      new Map(),
      snap as unknown as HTMLCanvasElement,
    );
    frames.push(performance.now() - t0);
  }
  const tBake = performance.now();
  stroke.commit();
  const bakeMs = performance.now() - tBake;
  return summarize(frames, samples.length, {
    lastMs: bakeMs,
    holdMs: hold ? frames[frames.length - 1]! : null,
    outlineN: 0,
    bakeMs,
  });
}

export function timeInkLab(
  samples: readonly InkLabSample[],
  hold: boolean,
): InkLabTiming {
  ensureOffscreenCanvas();
  if (samples.length === 0) {
    return {
      ...summarize([], 0, { lastMs: 0, holdMs: null, outlineN: 0, bakeMs: 0 }),
      backend: "none",
      bake: "catmull",
    };
  }
  const canvas = createCanvas(800, 600) as unknown as HTMLCanvasElement;
  const engine = createInkLabEngine();
  const backend = engine.attach(canvas);
  const frames: number[] = [];
  engine.down(samples[0]!);
  frames.push(engine.paint().frameMs);
  for (let i = 1; i < samples.length; i++) {
    engine.move([samples[i]!]);
    frames.push(engine.paint().frameMs);
  }
  const up = engine.up(samples[samples.length - 1]!);
  engine.paint();
  engine.destroy();
  return {
    ...summarize(frames, samples.length, {
      lastMs: up.bakeMs,
      holdMs: hold ? frames[frames.length - 1]! : null,
      outlineN: 0,
      bakeMs: up.bakeMs,
    }),
    backend,
    bake: up.bake,
  };
}

export function replayTape(
  name: string,
  samples: readonly InkLabSample[],
): TapeReplay {
  const hold = name === "hold";
  const pf = timePerfectFreehand(samples, hold);
  const speedStamp = timeSpeedStamp(samples, hold);
  const speedBakeMs = timeSpeedBake(samples);
  const ink2d = timeInkLab(samples, hold);
  return {
    name,
    n: samples.length,
    pf,
    speedStamp,
    speedBakeMs,
    ink2d,
  };
}

export function formatReplayHud(row: TapeReplay): string {
  const ms = (v: number) => v.toFixed(3);
  return (
    `${row.name} n=${row.n}\n` +
    `  PF     p50=${ms(row.pf.p50)} p95=${ms(row.pf.p95)} lift=${ms(row.pf.lastMs)} outline=${row.pf.outlineN}` +
    (row.pf.holdMs != null ? ` hold=${ms(row.pf.holdMs)}` : "") +
    `\n` +
    `  stamp  p50=${ms(row.speedStamp.p50)} p95=${ms(row.speedStamp.p95)}` +
    (row.speedStamp.holdMs != null ? ` hold=${ms(row.speedStamp.holdMs)}` : "") +
    `\n` +
    `  bake   commit=${ms(row.speedStamp.bakeMs ?? 0)} rdp+chaikin+turns=${ms(row.speedBakeMs)}\n` +
    `  inklab backend=${row.ink2d.backend} bake=${row.ink2d.bake} p50=${ms(row.ink2d.p50)} p95=${ms(row.ink2d.p95)}` +
    (row.ink2d.holdMs != null ? ` hold=${ms(row.ink2d.holdMs)}` : "") +
    ` lift=${ms(row.ink2d.bakeMs ?? 0)}`
  );
}

/** Used by tests; keep getStroke reachable so PF cannot be skipped. */
export function pfOutlineCount(samples: readonly InkLabSample[]): number {
  return getStroke(pfInput(samples), freehandStrokeOptions(true, false)).length;
}
