/**
 * Ink lab overlay HUD. Board performance overlay uses this readout.
 */

export type InkLabMsRange = {
  last: number;
  min: number;
  max: number;
  avg: number;
  n: number;
};

export type InkLabHud = {
  backend: string;
  paints: number;
  frameMs: number;
  rafMs: number;
  pts: number;
  segs: number;
  ekfMs: number;
  drawMs: number;
  hold: boolean;
  suffix: boolean;
  bakeMs: number;
  bake: string;
  tileMs?: number;
  sdfMs?: number;
  frameRange?: InkLabMsRange;
  rafRange?: InkLabMsRange;
  drawRange?: InkLabMsRange;
  ekfRange?: InkLabMsRange;
  spark?: readonly number[];
  /** One display vsync in ms. Spark hairline and red threshold follow this. */
  vsyncMs?: number;
};

export const INK_LAB_HUD_ZERO: InkLabHud = {
  backend: "none",
  paints: 0,
  frameMs: 0,
  rafMs: 0,
  pts: 0,
  segs: 0,
  ekfMs: 0,
  drawMs: 0,
  hold: false,
  suffix: true,
  bakeMs: 0,
  bake: "catmull",
};

/** Last paints drawn in the frame-time spark. About two seconds at 60 Hz. */
export const INK_LAB_SPARK_N = 120;

function emptyRange(): InkLabMsRange {
  return { last: 0, min: 0, max: 0, avg: 0, n: 0 };
}

function pushRange(range: InkLabMsRange, value: number): InkLabMsRange {
  if (!Number.isFinite(value)) return range;
  const n = range.n + 1;
  if (n === 1) {
    return { last: value, min: value, max: value, avg: value, n: 1 };
  }
  return {
    last: value,
    min: Math.min(range.min, value),
    max: Math.max(range.max, value),
    avg: range.avg + (value - range.avg) / n,
    n,
  };
}

function formatRange(
  label: string,
  value: number,
  digits: number,
  range?: InkLabMsRange,
): string {
  const unit = `${value.toFixed(digits)}ms`;
  if (!range || range.n < 1) return `${label} ${unit}`;
  return (
    `${label} ${unit}  ` +
    `${range.min.toFixed(digits)}–${range.max.toFixed(digits)}  ` +
    `avg ${range.avg.toFixed(digits)}`
  );
}

export function formatInkLabHud(hud: InkLabHud): string {
  return (
    `ink lab\n` +
    `backend ${hud.backend}\n` +
    `paints ${hud.paints}\n` +
    `${formatRange("frame", hud.frameMs, 1, hud.frameRange)}\n` +
    `${formatRange("raf", hud.rafMs, 1, hud.rafRange)}\n` +
    `pts ${hud.pts}\n` +
    `segs ${hud.segs}\n` +
    `${formatRange("ekf", hud.ekfMs, 2, hud.ekfRange)}\n` +
    `${formatRange("draw", hud.drawMs, 2, hud.drawRange)}\n` +
    `hold ${hud.hold ? "yes" : "no"}\n` +
    `suffix ${hud.suffix ? "hit" : "miss"}\n` +
    `bake ${hud.bakeMs.toFixed(1)}ms ${hud.bake}` +
    (hud.tileMs != null || hud.sdfMs != null
      ? `\ntile ${((hud.tileMs ?? 0)).toFixed(1)}ms  sdf ${((hud.sdfMs ?? 0)).toFixed(1)}ms`
      : "")
  );
}

export type InkLabHudStats = {
  reset: () => void;
  sample: (frameMs: number, rafMs: number, drawMs: number, ekfMs: number) => void;
  /** rAF only — skip-empty ticks must not pin frame/draw/spark at 0. */
  noteRaf: (rafMs: number) => void;
  snapshot: () => Pick<
    InkLabHud,
    "frameRange" | "rafRange" | "drawRange" | "ekfRange" | "spark"
  >;
};

/** Per-stroke min/max/avg plus a short frame-ms history for the spark. */
export function createInkLabHudStats(): InkLabHudStats {
  let frame = emptyRange();
  let raf = emptyRange();
  let draw = emptyRange();
  let ekf = emptyRange();
  const spark: number[] = [];

  return {
    reset() {
      frame = emptyRange();
      raf = emptyRange();
      draw = emptyRange();
      ekf = emptyRange();
      spark.length = 0;
    },
    sample(frameMs, rafMs, drawMs, ekfMs) {
      frame = pushRange(frame, frameMs);
      if (rafMs > 0) raf = pushRange(raf, rafMs);
      draw = pushRange(draw, drawMs);
      ekf = pushRange(ekf, ekfMs);
      spark.push(rafMs > 0 ? rafMs : frameMs);
      if (spark.length > INK_LAB_SPARK_N) spark.shift();
    },
    noteRaf(rafMs) {
      if (rafMs > 0) raf = pushRange(raf, rafMs);
    },
    snapshot() {
      return {
        frameRange: frame.n > 0 ? frame : undefined,
        rafRange: raf.n > 0 ? raf : undefined,
        drawRange: draw.n > 0 ? draw : undefined,
        ekfRange: ekf.n > 0 ? ekf : undefined,
        spark: spark.slice(),
      };
    },
  };
}
