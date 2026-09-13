import { describe, expect, it } from "vitest";

import {
  inkCanvasPixelsChanged,
  inkCanvasCssMatches,
  idleRemeshAfterStrokeMs,
  remeshOnHostBoundLift,
  instantReplayOnBackingResize,
  instantReplayOnCameraRebase,
  instantReplayOnFirstPresent,
  instantReplayOnPageWindow,
  instantReplayOnPointerDown,
  finishReplayWhileDrawing,
  instantReplayOnUndo,
  keepLivePaintPump,
  LIVE_HUD_FLUSH_MS,
  mutationIsInkChrome,
  pageStageMatchesCanvas,
  remeshOnCameraMovingEnd,
  remeshOnNestedHostScroll,
  samePaintedView,
  shiftSnapOnCameraRebase,
  shouldFlushLiveHud,
  skipCommittedReplay,
  skipHostBoundPresentWhileCameraBusy,
  skipHostBoundPresentWhilePagePan,
  skipReplayOnWheelAbort,
  usePreStrokeStamp,
} from "./liveHost";

/**
 * Main-thread occupancy of remesh vs a print burst.
 *
 * `remeshOnLift`: current bug — every lift that aborted remesh starts remesh
 * immediately. The next pointerdown cannot run until that step returns.
 *
 * `idleRemeshMs`: remesh only after the pen has been up this long. A word-gap
 * of 40ms never starts remesh; the next "t" is not queued.
 */
function simulatePrintBurst(opts: {
  letters: number;
  writeMs: number;
  betweenMs: number;
  remeshStepMs: number;
  remeshOnLift: boolean;
  idleRemeshMs: number;
}): { maxDownBlockMs: number; lastDownBlockMs: number } {
  let t = 0;
  let remeshBusyUntil = 0;
  let idleFireAt: number | null = null;
  let maxBlock = 0;
  let lastBlock = 0;
  for (let i = 0; i < opts.letters; i++) {
    if (!opts.remeshOnLift && idleFireAt != null && idleFireAt <= t && remeshBusyUntil <= t) {
      remeshBusyUntil = idleFireAt + opts.remeshStepMs;
      idleFireAt = null;
    }
    const downAt = Math.max(t, remeshBusyUntil);
    const block = downAt - t;
    maxBlock = Math.max(maxBlock, block);
    lastBlock = block;
    t = downAt;
    remeshBusyUntil = 0;
    idleFireAt = null;
    t += opts.writeMs;
    if (opts.remeshOnLift) remeshBusyUntil = t + opts.remeshStepMs;
    else idleFireAt = t + opts.idleRemeshMs;
    t += opts.betweenMs;
  }
  return { maxDownBlockMs: maxBlock, lastDownBlockMs: lastBlock };
}

function simulateFenceScroll(opts: {
  samples: number;
  remeshMs: number;
  restampMs: number;
  remeshEachSample: boolean;
}): { maxSampleMs: number; totalMs: number } {
  const sampleMs = opts.remeshEachSample ? opts.remeshMs : opts.restampMs;
  return { maxSampleMs: sampleMs, totalMs: sampleMs * opts.samples };
}

describe("live host contract", () => {
  it("blocks a full replay while the pointer is down", () => {
    expect(skipCommittedReplay(true, null)).toBe(true);
    expect(skipCommittedReplay(true, undefined)).toBe(true);
    expect(skipCommittedReplay(false, null)).toBe(false);
  });

  it("still allows a live highlighter stamp", () => {
    expect(skipCommittedReplay(true, { points: [] })).toBe(false);
  });

  it("uses the pre-stroke snap for a live highlighter instead of a full replay", () => {
    expect(usePreStrokeStamp({ points: [] }, true)).toBe(true);
    expect(usePreStrokeStamp({ points: [] }, false)).toBe(false);
    expect(usePreStrokeStamp(null, true)).toBe(false);
  });

  it("skips a camera remesh when the painted view did not move", () => {
    const view = { scrollX: 1, scrollY: 2, zoom: 1, width: 100, height: 80, marginY: 0 };
    expect(samePaintedView(view, view)).toBe(true);
    expect(samePaintedView(view, { ...view, scrollY: 3 })).toBe(false);
    expect(samePaintedView(null, view)).toBe(false);
  });

  it("pumps overlay paint for the whole stroke, not only hold ticks", () => {
    expect(keepLivePaintPump(true)).toBe(true);
    expect(keepLivePaintPump(false)).toBe(false);
  });

  it("holds overlay text off the vsync tick, then flushes on lift", () => {
    expect(shouldFlushLiveHud(0, 16, true)).toBe(true);
    expect(shouldFlushLiveHud(10, 10 + LIVE_HUD_FLUSH_MS - 1, true)).toBe(false);
    expect(shouldFlushLiveHud(10, 10 + LIVE_HUD_FLUSH_MS, true)).toBe(true);
    expect(shouldFlushLiveHud(10, 11, false)).toBe(true);
  });

  it("does not treat a CSS park as a backing-store resize", () => {
    expect(inkCanvasPixelsChanged({ width: 800, height: 1200 }, 800, 1200)).toBe(false);
    expect(inkCanvasPixelsChanged({ width: 800, height: 1200 }, 800, 1201)).toBe(true);
    expect(inkCanvasPixelsChanged({ width: 800, height: 1200 }, 801, 1200)).toBe(true);
  });

  it("treats already-written ink canvas CSS as a no-op", () => {
    const canvas = { style: { width: "800px", height: "1400px", top: "-100px", left: "0px" } };
    expect(inkCanvasCssMatches(canvas, 800, 1400, "-100px")).toBe(true);
    expect(inkCanvasCssMatches(canvas, 801, 1400, "-100px")).toBe(false);
  });

  it("does not remesh the notebook on a host-bound pen lift", () => {
    expect(remeshOnHostBoundLift()).toBe(false);
  });

  it("defers remesh after a letter so the next down is not queued behind it", () => {
    expect(idleRemeshAfterStrokeMs()).toBe(400);
    const remeshOnLift = simulatePrintBurst({
      letters: 8,
      writeMs: 80,
      betweenMs: 40,
      remeshStepMs: 500,
      remeshOnLift: true,
      idleRemeshMs: idleRemeshAfterStrokeMs(),
    });
    expect(remeshOnLift.maxDownBlockMs).toBeGreaterThan(400);
    const idle = simulatePrintBurst({
      letters: 8,
      writeMs: 80,
      betweenMs: 40,
      remeshStepMs: 500,
      remeshOnLift: false,
      idleRemeshMs: idleRemeshAfterStrokeMs(),
    });
    expect(idle.maxDownBlockMs).toBe(0);
  });

  it("does not remesh the notebook when the nib wheel aborts a live stroke", () => {
    expect(skipReplayOnWheelAbort()).toBe(true);
  });

  it("keeps a live resize atomic but slices first paint under loading", () => {
    expect(instantReplayOnBackingResize()).toBe(true);
    expect(instantReplayOnBackingResize(true)).toBe(false);
  });

  it("does not instantly remesh when the page LRU hydrates", () => {
    expect(instantReplayOnPageWindow()).toBe(false);
  });

  it("does not instantly remesh the first present after restore", () => {
    expect(instantReplayOnFirstPresent()).toBe(false);
  });

  it("does not remesh the notebook when a tool pick calls setCameraMoving(false)", () => {
    expect(remeshOnCameraMovingEnd(false)).toBe(false);
    expect(remeshOnCameraMovingEnd(true)).toBe(true);
  });

  it("does not instantly remesh the notebook on pointer down", () => {
    expect(instantReplayOnPointerDown()).toBe(false);
  });

  it("does not finish a sliced remesh onto the host while the nib is down", () => {
    expect(finishReplayWhileDrawing()).toBe(false);
  });

  it("does not remesh the notebook on the undo click stack", () => {
    expect(instantReplayOnUndo()).toBe(false);
  });

  it("slides pan but keeps a real camera rebase atomic", () => {
    expect(shiftSnapOnCameraRebase()).toBe(true);
    expect(instantReplayOnCameraRebase()).toBe(true);
  });

  it("does not remesh the notebook on nested fence scroll", () => {
    expect(remeshOnNestedHostScroll()).toBe(false);
    expect(skipHostBoundPresentWhileCameraBusy()).toBe(false);
    expect(skipHostBoundPresentWhilePagePan()).toBe(true);
  });

  it("rejects page stages from a different backing-store size", () => {
    expect(pageStageMatchesCanvas({ width: 100, height: 200 }, { width: 100, height: 200 })).toBe(
      true,
    );
    expect(pageStageMatchesCanvas({ width: 100, height: 200 }, { width: 100, height: 201 })).toBe(
      false,
    );
    expect(pageStageMatchesCanvas(null, { width: 100, height: 200 })).toBe(false);
  });

  it("keeps nested fence samples on a restamp, not a remesh", () => {
    const remesh = simulateFenceScroll({
      samples: 20,
      remeshMs: 40,
      restampMs: 2,
      remeshEachSample: true,
    });
    expect(remesh.maxSampleMs).toBe(40);
    const restamp = simulateFenceScroll({
      samples: 20,
      remeshMs: 40,
      restampMs: 2,
      remeshEachSample: remeshOnNestedHostScroll(),
    });
    expect(restamp.maxSampleMs).toBe(2);
  });

  it("ignores HUD mutations under the ink host", () => {
    const host = { contains: (node: Node) => node === host || node.parentNode === host };
    const hud = { parentNode: host } as unknown as Node;
    expect(mutationIsInkChrome([{ target: hud }], host as unknown as Node)).toBe(true);
    expect(mutationIsInkChrome([{ target: hud }], null)).toBe(false);
  });
});
