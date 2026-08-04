/**
 * Stroke-rate instrumentation for the raster pen.
 *
 * The pen bypasses Excalidraw and paints straight to a canvas, so nothing in
 * the framework can tell you whether the tablet's samples are arriving, being
 * coalesced away, or arriving faster than they can be painted. This does: it
 * counts what the app actually receives per stroke and what it costs to draw.
 *
 * Off by default and free when off — `enabled` is read once, and every method
 * returns on a boolean before touching anything. Turn it on with
 *
 *   localStorage.setItem("lc.ink.metrics", "1")
 *
 * and reload. Each stroke logs one line to the console, and the running summary
 * is on `window.__lcInkMetrics` for a session-wide read.
 *
 * `pointermove` rate is *not* the tablet's report rate: the browser hands over
 * one move per frame and buries the rest in `getCoalescedEvents()`. A pen
 * driver reporting well above display Hz will show ~60 moves/s and a much
 * higher sample rate, and the gap between the two is exactly what would be lost
 * without coalesced sampling.
 */

export interface InkStrokeMetrics {
  /** `pointermove` events the layer handled. */
  moves: number;
  /** Pointer samples read, coalesced ones included. */
  samples: number;
  /** Samples that only coalesced sampling recovered (`samples - moves`). */
  recovered: number;
  /** Wall time from pointerdown to pointerup, ms. */
  durationMs: number;
  moveHz: number;
  sampleHz: number;
  /** Mean event-timestamp → painted latency, ms. */
  meanLatencyMs: number;
  maxLatencyMs: number;
}

interface Totals {
  strokes: number;
  moves: number;
  samples: number;
  durationMs: number;
  latencySumMs: number;
  latencyCount: number;
  maxLatencyMs: number;
  last: InkStrokeMetrics | null;
  /** Pointer-path decisions that produced no stroke, counted by reason. */
  notes: Map<string, number>;
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem("lc.ink.metrics") === "1";
  } catch {
    return false;
  }
}

const enabled = typeof window !== "undefined" && readEnabled();

const totals: Totals = {
  strokes: 0,
  moves: 0,
  samples: 0,
  durationMs: 0,
  latencySumMs: 0,
  latencyCount: 0,
  maxLatencyMs: 0,
  last: null,
  notes: new Map<string, number>(),
};

let startedAt = 0;
let moves = 0;
let samples = 0;
let latencySum = 0;
let latencyCount = 0;
let maxLatency = 0;

export const inkMetrics = {
  enabled,

  begin(): void {
    if (!enabled) return;
    startedAt = performance.now();
    moves = 0;
    samples = 0;
    latencySum = 0;
    latencyCount = 0;
    maxLatency = 0;
  },

  /**
   * A `pointerdown` that produced no stroke, or a stroke that had to take a
   * degraded path — recorded by reason.
   *
   * Every one of these was a silent `return` before, which is exactly the shape
   * of "I wrote a letter and nothing happened": there was no way, from outside,
   * to tell a dropped press from one that drew nothing visible. Now the reason
   * lands in the console and on `__lcInkMetrics.summary().notes`, so the two
   * cases can be told apart. `second-pointer` is a resting hand being kept out
   * of an open stroke and is expected while writing; `no-viewport`,
   * `off-canvas`, `no-capture` and `orphan-commit` are not.
   */
  note(reason: string): void {
    if (!enabled) return;
    totals.notes.set(reason, (totals.notes.get(reason) ?? 0) + 1);
    // eslint-disable-next-line no-console
    console.info(`[ink] ${reason}`);
  },

  /** One `pointermove` carrying `sampleCount` pointer samples. */
  move(sampleCount: number): void {
    if (!enabled) return;
    moves += 1;
    samples += sampleCount;
  },

  /** Painted the batch that began with an event stamped `eventTimeMs`. */
  painted(eventTimeMs: number): void {
    if (!enabled) return;
    // `event.timeStamp` shares the origin with `performance.now()`.
    const latency = performance.now() - eventTimeMs;
    if (!Number.isFinite(latency) || latency < 0) return;
    latencySum += latency;
    latencyCount += 1;
    if (latency > maxLatency) maxLatency = latency;
  },

  end(): InkStrokeMetrics | null {
    if (!enabled || startedAt === 0) return null;
    const durationMs = performance.now() - startedAt;
    startedAt = 0;
    const seconds = durationMs / 1000;
    const metrics: InkStrokeMetrics = {
      moves,
      samples,
      recovered: Math.max(0, samples - moves),
      durationMs: Math.round(durationMs),
      moveHz: seconds > 0 ? Math.round(moves / seconds) : 0,
      sampleHz: seconds > 0 ? Math.round(samples / seconds) : 0,
      meanLatencyMs:
        latencyCount > 0 ? Math.round((latencySum / latencyCount) * 100) / 100 : 0,
      maxLatencyMs: Math.round(maxLatency * 100) / 100,
    };

    totals.strokes += 1;
    totals.moves += moves;
    totals.samples += samples;
    totals.durationMs += durationMs;
    totals.latencySumMs += latencySum;
    totals.latencyCount += latencyCount;
    totals.maxLatencyMs = Math.max(totals.maxLatencyMs, maxLatency);
    totals.last = metrics;

    // Strokes shorter than a flick are noise — the rates are meaningless.
    if (durationMs >= 150) {
      // eslint-disable-next-line no-console
      console.info(
        `[ink] ${metrics.moveHz} moves/s · ${metrics.sampleHz} samples/s ` +
          `(+${metrics.recovered} coalesced) · paint ${metrics.meanLatencyMs}ms mean, ` +
          `${metrics.maxLatencyMs}ms max · ${metrics.durationMs}ms stroke`,
      );
    }
    return metrics;
  },

  /** Session totals, for reading off the console after a writing session. */
  summary() {
    const seconds = totals.durationMs / 1000;
    return {
      strokes: totals.strokes,
      moveHz: seconds > 0 ? Math.round(totals.moves / seconds) : 0,
      sampleHz: seconds > 0 ? Math.round(totals.samples / seconds) : 0,
      recovered: Math.max(0, totals.samples - totals.moves),
      meanLatencyMs:
        totals.latencyCount > 0
          ? Math.round((totals.latencySumMs / totals.latencyCount) * 100) / 100
          : 0,
      maxLatencyMs: Math.round(totals.maxLatencyMs * 100) / 100,
      last: totals.last,
      notes: Object.fromEntries(totals.notes),
    };
  },
};

if (enabled) {
  (window as unknown as { __lcInkMetrics: typeof inkMetrics }).__lcInkMetrics = inkMetrics;
}
