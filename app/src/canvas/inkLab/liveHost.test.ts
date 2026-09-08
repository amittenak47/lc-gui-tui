import { describe, expect, it } from "vitest";

import {
  keepLivePaintPump,
  LIVE_HUD_FLUSH_MS,
  shouldFlushLiveHud,
  skipCommittedReplay,
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
