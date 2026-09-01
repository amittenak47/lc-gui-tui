import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INK_GRAIN_DEFAULT,
  INK_SPEED_FADE_DEFAULT,
  grainFromPercent,
  grainToPercent,
  loadInkGrain,
  loadInkSpeedFade,
  saveInkGrain,
  saveInkSpeedFade,
  speedFadeFromPercent,
  speedFadeToPercent,
} from "./inkSpeedPref";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("inkSpeedFade", () => {
  it("defaults to 0 so speed ink is width-only until turned up", () => {
    expect(loadInkSpeedFade()).toBe(INK_SPEED_FADE_DEFAULT);
    expect(INK_SPEED_FADE_DEFAULT).toBe(0);
  });

  it("round-trips a percent dial", () => {
    saveInkSpeedFade(speedFadeFromPercent(40));
    expect(speedFadeToPercent(loadInkSpeedFade())).toBe(40);
  });
});

describe("inkGrain", () => {
  it("defaults to 0 so old notes stay a hard disc", () => {
    expect(loadInkGrain()).toBe(INK_GRAIN_DEFAULT);
    expect(INK_GRAIN_DEFAULT).toBe(0);
  });

  it("round-trips a percent dial", () => {
    saveInkGrain(grainFromPercent(35));
    expect(grainToPercent(loadInkGrain())).toBe(35);
  });
});
