import { describe, expect, it } from "vitest";

import {
  keepLivePaintPump,
  LIVE_HUD_FLUSH_MS,
  samePaintedView,
  shouldFlushLiveHud,
  skipCommittedReplay,
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
});
