/**
 * Stroke-rate instrumentation for the raster pen.
 *
 * The pen bypasses Excalidraw and paints straight to a canvas, so nothing in
 * the framework can tell you whether the tablet's samples are arriving, being
 * coalesced away, or arriving faster than they can be painted. This does: it
 * counts what the app actually receives per stroke and what it costs to draw.
 *
 * Off by default and free when off. Call sites in RasterInkLayer are behind
 * `DEBUG_INK` so the hot path never touches this module (clear for performance
 * profiling). Flip `DEBUG_INK` to `true` and rebuild to collect stroke-rate
 * numbers. Each stroke logs one line to the console, and the running summary
 * is on `window.__lcInkMetrics` for a session-wide read.
 *
 * `pointermove` rate is *not* the tablet's report rate: the browser hands over
 * one move per frame and buries the rest in `getCoalescedEvents()`. A pen
 * driver reporting well above display Hz will show ~60 moves/s and a much
 * higher sample rate, and the gap between the two is exactly what would be lost
 * without coalesced sampling.
 *
 * ## Reading the latency numbers
 *
 * `paint` is measured from the *dispatched* event's timestamp, and a dispatched
 * `pointermove` carries the **newest** sample in its batch — the older ones are
 * in `getCoalescedEvents()`. That makes it the wrong number to look at alone,
 * and wrong in the flattering direction: block the main thread for 300ms and
 * the browser does not queue 300ms of moves, it coalesces them into one move
 * stamped a millisecond before the handler finally runs. The freeze reads as a
 * ~2ms paint. So a low `paint max` is not evidence that the ink kept up.
 *
 * Three numbers exist to close that hole, and they are the ones to read when
 * ink appears late:
 *
 * - `stale` — age of the *oldest* sample in a batch when the batch was handled.
 *   This is how far behind the hand the ink actually was. One frame is normal;
 *   coalescing cannot push it past the stall that produced it.
 * - `gap` — longest stretch with no move handled at all. Frame time is normal
 *   (11ms at 90Hz, 17ms at 60); anything near a glyph's duration means the
 *   thread was gone, whatever `paint` says.
 * - `frame` — from finishing the draw calls to the start of the next animation
 *   frame. Canvas draws are queued, not presented, so this is the closest thing
 *   here to "and then it was on screen". A large `frame` with a small `stale`
 *   means the ink was drawn on time and shown late, which is a compositor
 *   problem and not an input one.
 *
 * `gap` says the thread was gone; `blocked` says what took it, from the
 * browser's own long-task reporting, and appears only on strokes that had one.
 * Between them a stalled stroke names its own culprit.
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
  /** Worst age of the oldest sample in a batch when that batch was handled, ms. */
  maxSampleAgeMs: number;
  /** Longest stretch with no `pointermove` handled, ms. The first spans pointerdown. */
  maxGapMs: number;
  /** Worst draw-calls-returned → next animation frame, ms. */
  maxFrameMs: number;
  /** Long tasks (>50ms) that overlapped the stroke. */
  longTasks: number;
  /** How much of the stroke was spent inside those tasks, ms. */
  blockedMs: number;
  /** Duration of the worst of them, ms — the whole task, not just the overlap. */
  maxLongTaskMs: number;
}

interface Totals {
  strokes: number;
  moves: number;
  samples: number;
  durationMs: number;
  latencySumMs: number;
  latencyCount: number;
  maxLatencyMs: number;
  maxSampleAgeMs: number;
  maxGapMs: number;
  maxFrameMs: number;
  longTasks: number;
  blockedMs: number;
  maxLongTaskMs: number;
  last: InkStrokeMetrics | null;
  /** Pointer-path decisions that produced no stroke, counted by reason. */
  notes: Map<string, number>;
}

/** A task the browser reported as blocking, in `performance.now()` terms. */
interface LongTask {
  start: number;
  end: number;
}

/**
 * Master switch for ink metrics. `false` keeps RasterInkLayer call sites dead
 * (out of profiles); flip to `true` and rebuild to collect stroke-rate numbers.
 */
export const DEBUG_INK = false;

function metricsActive(): boolean {
  if (DEBUG_INK) return true;
  return (globalThis as { __LC_INK_DEBUG__?: boolean }).__LC_INK_DEBUG__ === true;
}

const totals: Totals = {
  strokes: 0,
  moves: 0,
  samples: 0,
  durationMs: 0,
  latencySumMs: 0,
  latencyCount: 0,
  maxLatencyMs: 0,
  maxSampleAgeMs: 0,
  maxGapMs: 0,
  maxFrameMs: 0,
  longTasks: 0,
  blockedMs: 0,
  maxLongTaskMs: 0,
  last: null,
  notes: new Map<string, number>(),
};

let startedAt = 0;
let moves = 0;
let samples = 0;
let latencySum = 0;
let latencyCount = 0;
let maxLatency = 0;
let maxSampleAge = 0;
let maxGap = 0;
let maxFrame = 0;
/** When the last move was handled, for {@link maxGap}. Seeded by `begin`. */
let lastMoveAt = 0;
/** One frame probe in flight at a time — the rest of the stroke's are the same frame. */
let framePending = false;

/**
 * Long tasks seen recently, newest last.
 *
 * `gap` says the thread was gone; this says what took it. The browser only
 * reports tasks over 50ms, which is the right threshold here — anything that
 * costs a writer a frame at 90Hz and is worth naming is well past it.
 */
const longTaskLog: LongTask[] = [];
/** Two strokes' worth of blocking is plenty of history to keep around. */
const LONG_TASK_LOG_CAP = 64;
let longTaskObserver: PerformanceObserver | null = null;

function recordLongTasks(entries: PerformanceEntryList): void {
  for (const entry of entries) {
    longTaskLog.push({ start: entry.startTime, end: entry.startTime + entry.duration });
  }
  if (longTaskLog.length > LONG_TASK_LOG_CAP) {
    longTaskLog.splice(0, longTaskLog.length - LONG_TASK_LOG_CAP);
  }
}

function watchLongTasks(): void {
  if (typeof PerformanceObserver !== "function") return;
  try {
    longTaskObserver = new PerformanceObserver((list) => recordLongTasks(list.getEntries()));
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    // Not every engine ships the entry type, and observing an unknown one
    // throws. The rest of the numbers stand on their own without it.
    longTaskObserver = null;
  }
}

export const inkMetrics = {
  get enabled() {
    return metricsActive();
  },

  begin(): void {
    if (!metricsActive()) return;
    ensureInstalled();
    startedAt = performance.now();
    lastMoveAt = startedAt;
    moves = 0;
    samples = 0;
    latencySum = 0;
    latencyCount = 0;
    maxLatency = 0;
    maxSampleAge = 0;
    maxGap = 0;
    maxFrame = 0;
    // Anything that finished before the pen touched down belongs to the last
    // stroke, or to no stroke at all. Entries arrive in end order, so the
    // expired ones are a prefix.
    let expired = 0;
    while (expired < longTaskLog.length && longTaskLog[expired].end < startedAt) {
      expired += 1;
    }
    if (expired > 0) longTaskLog.splice(0, expired);
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
    if (!metricsActive()) return;
    totals.notes.set(reason, (totals.notes.get(reason) ?? 0) + 1);
    // eslint-disable-next-line no-console
    console.info(`[ink] ${reason}`);
  },

  /**
   * One `pointermove` carrying `sampleCount` pointer samples, the oldest of
   * them stamped `oldestTimeMs`.
   *
   * The gap since the previous move is the honest stall detector: a blocked
   * main thread does not delay the dispatched move's timestamp, it just stops
   * dispatching, and only the wall clock between handlers can see that.
   */
  move(sampleCount: number, oldestTimeMs?: number): void {
    if (!metricsActive()) return;
    moves += 1;
    samples += sampleCount;

    const now = performance.now();
    const gap = now - lastMoveAt;
    lastMoveAt = now;
    if (Number.isFinite(gap) && gap > maxGap) maxGap = gap;

    if (oldestTimeMs === undefined) return;
    // `event.timeStamp` shares the origin with `performance.now()`.
    const age = now - oldestTimeMs;
    if (Number.isFinite(age) && age > maxSampleAge) maxSampleAge = age;
  },

  /**
   * Finished the draw calls for the batch dispatched as an event stamped
   * `eventTimeMs`.
   *
   * Two clocks stop here. The latency against the event is what the pen paid to
   * reach the canvas — read it with the caveat at the top of this file, since
   * the stamp belongs to the newest sample in the batch. The frame probe runs
   * on from here to the start of the next animation frame, because a 2D draw
   * call only queues work: without it there is no way to tell ink that was
   * drawn late from ink that was drawn on time and presented late.
   */
  painted(eventTimeMs: number): void {
    if (!metricsActive()) return;
    const paintedAt = performance.now();
    if (!framePending && typeof requestAnimationFrame === "function") {
      framePending = true;
      requestAnimationFrame((frameTimeMs) => {
        framePending = false;
        // The rAF argument is the frame's start time, on the same origin.
        const wait = frameTimeMs - paintedAt;
        if (Number.isFinite(wait) && wait > maxFrame) maxFrame = wait;
      });
    }

    const latency = paintedAt - eventTimeMs;
    if (!Number.isFinite(latency) || latency < 0) return;
    latencySum += latency;
    latencyCount += 1;
    if (latency > maxLatency) maxLatency = latency;
  },

  end(): InkStrokeMetrics | null {
    if (!metricsActive() || startedAt === 0) return null;
    const endedAt = performance.now();
    const durationMs = endedAt - startedAt;
    const seconds = durationMs / 1000;

    // A task that ended a moment ago may not have reached the callback yet, and
    // the last one before the lift is the one most worth having.
    recordLongTasks(longTaskObserver?.takeRecords() ?? []);
    let longTasks = 0;
    let blockedMs = 0;
    let maxLongTaskMs = 0;
    for (const task of longTaskLog) {
      const overlap = Math.min(task.end, endedAt) - Math.max(task.start, startedAt);
      if (overlap <= 0) continue;
      longTasks += 1;
      blockedMs += overlap;
      maxLongTaskMs = Math.max(maxLongTaskMs, task.end - task.start);
    }
    startedAt = 0;
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
      maxSampleAgeMs: Math.round(maxSampleAge * 100) / 100,
      maxGapMs: Math.round(maxGap * 100) / 100,
      maxFrameMs: Math.round(maxFrame * 100) / 100,
      longTasks,
      blockedMs: Math.round(blockedMs * 100) / 100,
      maxLongTaskMs: Math.round(maxLongTaskMs * 100) / 100,
    };

    totals.strokes += 1;
    totals.moves += moves;
    totals.samples += samples;
    totals.durationMs += durationMs;
    totals.latencySumMs += latencySum;
    totals.latencyCount += latencyCount;
    totals.maxLatencyMs = Math.max(totals.maxLatencyMs, maxLatency);
    totals.maxSampleAgeMs = Math.max(totals.maxSampleAgeMs, maxSampleAge);
    totals.maxGapMs = Math.max(totals.maxGapMs, maxGap);
    totals.maxFrameMs = Math.max(totals.maxFrameMs, maxFrame);
    totals.longTasks += longTasks;
    totals.blockedMs += blockedMs;
    totals.maxLongTaskMs = Math.max(totals.maxLongTaskMs, maxLongTaskMs);
    totals.last = metrics;

    // Strokes shorter than a flick are noise — the rates are meaningless.
    if (durationMs >= 150) {
      // Only worth a column on the strokes that had any; a clean stroke's line
      // is long enough already.
      const blocked =
        longTasks > 0
          ? ` · blocked ${metrics.blockedMs}ms in ${longTasks} ` +
            `task${longTasks === 1 ? "" : "s"} (${metrics.maxLongTaskMs}ms worst)`
          : "";
      // eslint-disable-next-line no-console
      console.info(
        `[ink] ${metrics.moveHz} moves/s · ${metrics.sampleHz} samples/s ` +
          `(+${metrics.recovered} coalesced) · paint ${metrics.meanLatencyMs}ms mean, ` +
          `${metrics.maxLatencyMs}ms max · stale ${metrics.maxSampleAgeMs}ms max · ` +
          `gap ${metrics.maxGapMs}ms max · frame ${metrics.maxFrameMs}ms max` +
          `${blocked} · ${metrics.durationMs}ms stroke`,
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
      maxSampleAgeMs: Math.round(totals.maxSampleAgeMs * 100) / 100,
      maxGapMs: Math.round(totals.maxGapMs * 100) / 100,
      maxFrameMs: Math.round(totals.maxFrameMs * 100) / 100,
      longTasks: totals.longTasks,
      blockedMs: Math.round(totals.blockedMs * 100) / 100,
      maxLongTaskMs: Math.round(totals.maxLongTaskMs * 100) / 100,
      last: totals.last,
      notes: Object.fromEntries(totals.notes),
    };
  },
};

let installed = false;
function ensureInstalled(): void {
  if (installed || !metricsActive() || typeof window === "undefined") return;
  installed = true;
  (window as unknown as { __lcInkMetrics: typeof inkMetrics }).__lcInkMetrics = inkMetrics;
  watchLongTasks();
}

if (DEBUG_INK) ensureInstalled();
