import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INK_SPEED_FADE_DEFAULT,
  INK_SPEED_BODY_ACCENT_DEFAULT,
  loadInkSpeedFade,
  loadInkSpeedBodyAccent,
  saveInkSpeedFade,
  saveInkSpeedBodyAccent,
  speedFadeFromPercent,
  speedFadeToPercent,
  speedBodyAccentFromPercent,
  speedBodyAccentToPercent,
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

describe("inkSpeedBodyAccent", () => {
  it("defaults to 0 so Speed ink is the linear line until turned up", () => {
    expect(loadInkSpeedBodyAccent()).toBe(INK_SPEED_BODY_ACCENT_DEFAULT);
    expect(INK_SPEED_BODY_ACCENT_DEFAULT).toBe(0);
  });

  it("round-trips a percent dial", () => {
    saveInkSpeedBodyAccent(speedBodyAccentFromPercent(70));
    expect(speedBodyAccentToPercent(loadInkSpeedBodyAccent())).toBe(70);
  });
});
