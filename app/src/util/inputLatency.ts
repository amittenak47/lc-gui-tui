/**
 * How late the reading surface heard the finger, and what was holding the
 * thread when it landed.
 *
 * The PDF reader does a lot of work in the gaps between gestures — decoding
 * skipped pages into the sheet LRU, compressing evicted sheets into the PNG
 * pagefile, filling filmstrip thumbs. All of it is guarded by
 * `isDocCameraLive()`, and all of those guards are *cooperative*: they are
 * read between `await`s, so they can stop the next step and can do nothing
 * about the step already on the stack. A `pointerdown` cannot even be
 * dispatched until that step returns. Freezing the pump at pointerdown is
 * therefore the wrong lever for this failure — by the time the handler runs,
 * the delay has already been paid.
 *
 * The only thing that shortens it is making each background step small, and
 * the only way to know whether it is small is to measure it on the device.
 * That is what this is. `event.timeStamp` on a pointer event is stamped when
 * the platform produced the sample, on the same clock as `performance.now()`,
 * so the difference at the top of the handler is exactly the input delay the
 * reader feels: finger down to app hears it.
 *
 * Recording is always on — one subtraction and a ring-buffer push, a few
 * times a second at most. Blame is not: set `__LC_SCROLL_DEBUG__` to `true`
 * (devtools over `npm run logs:android`, no rebuild) and every background job
 * brackets itself, so a slow `pointerdown` can name what was open when it
 * landed and the browser's own long-task reporting says how long that ran.
 *
 * Read it with `__lcScrollLatency.summary()`.
 */

/** Samples kept for the summary. A minute of reading is well under this. */
const SAMPLE_CAP = 120;
/** Long tasks kept for blame, newest last. */
const LONG_TASK_CAP = 32;

/**
 * Delays under this are a frame or two and not worth a name.
 *
 * 50ms is the browser's own long-task threshold and about where a scroll
 * stops feeling attached to the finger.
 */
export const INPUT_DELAY_BLAME_MS = 50;

/**
 * Above this the sample is a clock disagreement, not a stall.
 *
 * `timeStamp` is 0 on synthetic events (jsdom, dispatched `PointerEvent`s in
 * tests) and on hosts that do not stamp them, which would read as an
 * hours-long delay and poison every number here.
 */
const MAX_PLAUSIBLE_DELAY_MS = 5_000;

export interface InputDelaySample {
  /** Finger down → handler entered, ms. */
  delayMs: number;
  /** `performance.now()` when the handler ran. */
  at: number;
  /** Background jobs open when it landed, when blame is on. */
  blame: string[];
  /** Duration of the worst long task overlapping the delay, ms. 0 = none seen. */
  blockedMs: number;
}

interface LongTask {
  start: number;
  end: number;
}

const samples: InputDelaySample[] = [];
const openJobs = new Map<string, number>();
const longTasks: LongTask[] = [];
let longTaskObserver: PerformanceObserver | null = null;
let installed = false;

function blameActive(): boolean {
  return (globalThis as { __LC_SCROLL_DEBUG__?: boolean }).__LC_SCROLL_DEBUG__ === true;
}

function recordLongTasks(entries: PerformanceEntryList): void {
  for (const entry of entries) {
    longTasks.push({ start: entry.startTime, end: entry.startTime + entry.duration });
  }
  if (longTasks.length > LONG_TASK_CAP) {
    longTasks.splice(0, longTasks.length - LONG_TASK_CAP);
  }
}

/**
 * Install the long-task observer and the devtools handle, once.
 *
 * Lazy rather than at import: a build that never opens a document should not
 * pay for an observer, and `PerformanceObserver` throws on an entry type the
 * engine does not ship.
 */
function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  if (typeof globalThis !== "undefined") {
    (globalThis as { __lcScrollLatency?: unknown }).__lcScrollLatency = readingLatency;
  }
  if (typeof PerformanceObserver !== "function") return;
  try {
    longTaskObserver = new PerformanceObserver((list) => recordLongTasks(list.getEntries()));
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    // The delay numbers stand on their own without it.
    longTaskObserver = null;
  }
}

/**
 * Bracket a unit of background work so a stalled gesture can name it.
 *
 * With blame off this is a flag read and a shared no-op back; the label its
 * caller built is the only cost, and these are per-page, not per-frame.
 */
const NO_JOB = () => {};

export function openBackgroundJob(label: string): () => void {
  if (!blameActive()) return NO_JOB;
  ensureInstalled();
  const at = performance.now();
  openJobs.set(label, at);
  return () => {
    openJobs.delete(label);
  };
}

/** Worst long task overlapping `[from, to]`, in ms. */
function blockedWithin(from: number, to: number): number {
  let worst = 0;
  for (const task of longTasks) {
    if (task.end < from || task.start > to) continue;
    const duration = task.end - task.start;
    if (duration > worst) worst = duration;
  }
  return worst;
}

/**
 * One `pointerdown` on the reading surface. Returns the delay in ms, or 0
 * when the event carries no usable timestamp.
 *
 * Call it at the top of the handler: anything done first is counted as the
 * app's, not the platform's.
 */
export function noteReadingPointerDown(event: { timeStamp: number }): number {
  const now = performance.now();
  const stamp = event.timeStamp;
  if (!Number.isFinite(stamp) || stamp <= 0) return 0;
  const delayMs = now - stamp;
  if (!(delayMs >= 0) || delayMs > MAX_PLAUSIBLE_DELAY_MS) return 0;
  ensureInstalled();

  const blame: string[] = [];
  let blockedMs = 0;
  if (blameActive()) {
    for (const label of openJobs.keys()) blame.push(label);
    blockedMs = blockedWithin(stamp, now);
    if (delayMs >= INPUT_DELAY_BLAME_MS) {
      // eslint-disable-next-line no-console
      console.info(
        `[scroll] ${Math.round(delayMs)}ms to hear the finger` +
          (blockedMs > 0 ? `, worst task ${Math.round(blockedMs)}ms` : "") +
          (blame.length > 0 ? `, open: ${blame.join(", ")}` : ", nothing open"),
      );
    }
  }

  samples.push({ delayMs, at: now, blame, blockedMs });
  if (samples.length > SAMPLE_CAP) samples.splice(0, samples.length - SAMPLE_CAP);
  return delayMs;
}

export interface InputDelaySummary {
  count: number;
  meanMs: number;
  /** 95th percentile — the one the reader remembers. */
  p95Ms: number;
  maxMs: number;
  /** Samples at or over {@link INPUT_DELAY_BLAME_MS}. */
  slow: number;
  /** Slowest samples, worst first. */
  worst: InputDelaySample[];
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
  return sorted[at] ?? 0;
}

export function summariseInputDelay(
  from: readonly InputDelaySample[] = samples,
): InputDelaySummary {
  const delays = from.map((sample) => sample.delayMs).sort((a, b) => a - b);
  const sum = delays.reduce((total, value) => total + value, 0);
  return {
    count: from.length,
    meanMs: from.length > 0 ? sum / from.length : 0,
    p95Ms: percentile(delays, 0.95),
    maxMs: delays.at(-1) ?? 0,
    slow: delays.filter((value) => value >= INPUT_DELAY_BLAME_MS).length,
    worst: [...from].sort((a, b) => b.delayMs - a.delayMs).slice(0, 5),
  };
}

export const readingLatency = {
  summary(): InputDelaySummary {
    return summariseInputDelay();
  },
  samples(): InputDelaySample[] {
    return [...samples];
  },
  reset(): void {
    samples.length = 0;
    longTasks.length = 0;
    openJobs.clear();
  },
};

export function resetInputLatencyForTests(): void {
  readingLatency.reset();
  longTaskObserver?.disconnect();
  longTaskObserver = null;
  installed = false;
}
