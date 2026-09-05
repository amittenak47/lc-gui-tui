/**
 * Live-stroke load for the canvas lift bar.
 *
 * Counts each live tick+paint while the pointer is down and turns overruns,
 * dropped frames, queued samples, and full remeshes into a 0–1 level. Red
 * means the open stroke is costing more than a frame — lift so the prefix can
 * bake instead of growing the live ribbon.
 *
 * Always on and cheap: a handful of adds per animation frame. Not the
 * DEBUG_INK console sampler.
 */

/** Paint+tessellate budget. A 60Hz ribbon frame is often 15ms; 14ms was red immediately. */
export const INK_LOAD_BUDGET_MS = 18;
/** rAF period that still counts as one display frame. */
export const INK_LOAD_RAF_OK_MS = 16;
/** rAF period that means a frame was dropped while the pen was down. */
export const INK_LOAD_RAF_STALL_MS = 28;
/** Accumulated overrun (ms) that fills the bar to red. */
export const INK_LOAD_DEBT_RED_MS = 400;
/** Slow live paints that fill the bar to red. */
export const INK_LOAD_SLOW_RED = 48;
/** Extra debt when a long stroke remeshes from vertex 0. */
export const INK_LOAD_REMESH_TAX_MS = 10;
/** Queued ring samples above this mean ingest is ahead of paint. */
export const INK_LOAD_QUEUE_SLOW = 8;
export const INK_LOAD_QUEUE_TAX_MS = 0.4;
export const INK_LOAD_EMA = 0.18;
/** Level at which the bar pulses and asks for a lift. */
export const INK_LOAD_LIFT = 0.92;

export type InkLoadFrame = {
  /** Tick + overlay paint (and a fallback tile repaint, if that ran). */
  frameMs: number;
  /** Time since the previous live paint. 0 on the first frame of a stroke. */
  rafMs: number;
  spineN: number;
  dirtyFrom: number;
  suffixHit: boolean;
  /** Pointer samples waiting on the ring before this tick drained them. */
  queued: number;
};

export type InkLoadSnapshot = {
  calls: number;
  slowCalls: number;
  debtMs: number;
  ema: number;
  level: number;
  lift: boolean;
  frameMs: number;
  rafMs: number;
  spineN: number;
  queued: number;
  dirtyFrom: number;
  suffixHit: boolean;
};

function clamp01(n: number): number {
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function snapshot(
  calls: number,
  slowCalls: number,
  debtMs: number,
  ema: number,
  last: InkLoadFrame | null,
): InkLoadSnapshot {
  const level = clamp01(
    Math.max(ema, debtMs / INK_LOAD_DEBT_RED_MS, slowCalls / INK_LOAD_SLOW_RED),
  );
  return {
    calls,
    slowCalls,
    debtMs,
    ema,
    level,
    lift: level >= INK_LOAD_LIFT,
    frameMs: last?.frameMs ?? 0,
    rafMs: last?.rafMs ?? 0,
    spineN: last?.spineN ?? 0,
    queued: last?.queued ?? 0,
    dirtyFrom: last?.dirtyFrom ?? 0,
    suffixHit: last?.suffixHit ?? true,
  };
}

/** Temporary on-canvas readout of the live-paint counters. */
export function formatInkLoadDebug(s: InkLoadSnapshot): string {
  const suffix = s.suffixHit ? "hit" : "miss";
  return [
    `paints ${s.calls}  slow ${s.slowCalls}`,
    `debt ${Math.round(s.debtMs)}ms  ema ${s.ema.toFixed(2)}`,
    `frame ${s.frameMs.toFixed(1)}ms  raf ${s.rafMs.toFixed(1)}ms`,
    `queue ${s.queued}  spine ${s.spineN}`,
    `suffix ${suffix}  dirty ${s.dirtyFrom}`,
  ].join("\n");
}

export function createInkLoadMeter(): {
  begin: () => InkLoadSnapshot;
  frame: (sample: InkLoadFrame) => InkLoadSnapshot;
  end: () => InkLoadSnapshot;
  peek: () => InkLoadSnapshot;
} {
  let open = false;
  let calls = 0;
  let slowCalls = 0;
  let debtMs = 0;
  let ema = 0;
  let last: InkLoadFrame | null = null;

  const peek = (): InkLoadSnapshot =>
    snapshot(calls, slowCalls, debtMs, ema, last);

  return {
    begin(): InkLoadSnapshot {
      open = true;
      calls = 0;
      slowCalls = 0;
      debtMs = 0;
      ema = 0;
      last = null;
      return peek();
    },

    frame(sample: InkLoadFrame): InkLoadSnapshot {
      if (!open) return peek();
      calls += 1;
      last = sample;
      const paintOver = Math.max(0, sample.frameMs - INK_LOAD_BUDGET_MS);
      const rafOver =
        sample.rafMs > INK_LOAD_RAF_STALL_MS
          ? sample.rafMs - INK_LOAD_RAF_OK_MS
          : 0;
      debtMs += paintOver + rafOver * 0.5;
      if (paintOver > 0 || rafOver > 0) slowCalls += 1;
      if (sample.spineN >= 32 && !sample.suffixHit && sample.dirtyFrom === 0) {
        debtMs += INK_LOAD_REMESH_TAX_MS;
      }
      if (sample.queued > INK_LOAD_QUEUE_SLOW) {
        debtMs += (sample.queued - INK_LOAD_QUEUE_SLOW) * INK_LOAD_QUEUE_TAX_MS;
      }
      const instant = clamp01(sample.frameMs / (INK_LOAD_BUDGET_MS * 2));
      ema = ema * (1 - INK_LOAD_EMA) + instant * INK_LOAD_EMA;
      return peek();
    },

    end(): InkLoadSnapshot {
      open = false;
      return peek();
    },

    peek,
  };
}
