import { describe, expect, it } from "vitest";

import {
  inkCanvasPixelsChanged,
  instantReplayOnBackingResize,
  instantReplayOnCameraRebase,
  instantReplayOnFirstPresent,
  instantReplayOnPageWindow,
  instantReplayOnPointerDown,
  instantReplayOnUndo,
  keepLivePaintPump,
  LIVE_HUD_FLUSH_MS,
  mutationIsInkChrome,
  remeshOnCameraMovingEnd,
  samePaintedView,
  shiftSnapOnCameraRebase,
  shouldFlushLiveHud,
  skipCommittedReplay,
  skipReplayOnWheelAbort,
  usePreStrokeStamp,
} from "./liveHost";

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

  it("does not remesh the notebook on the undo click stack", () => {
    expect(instantReplayOnUndo()).toBe(false);
  });

  it("slides pan but keeps a real camera rebase atomic", () => {
    expect(shiftSnapOnCameraRebase()).toBe(true);
    expect(instantReplayOnCameraRebase()).toBe(true);
  });

  it("ignores HUD mutations under the ink host", () => {
    const host = { contains: (node: Node) => node === host || node.parentNode === host };
    const hud = { parentNode: host } as unknown as Node;
    expect(mutationIsInkChrome([{ target: hud }], host as unknown as Node)).toBe(true);
    expect(mutationIsInkChrome([{ target: hud }], null)).toBe(false);
  });
});
