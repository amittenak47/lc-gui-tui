import { describe, expect, it } from "vitest";

import {
  ANDROID_STATUS_FALLBACK_PX,
  combineTopInset,
  KEYBOARD_GAP_MIN_PX,
  NAV_GAP_CAP_PX,
  splitBottomInsets,
} from "./safeArea";

describe("splitBottomInsets", () => {
  it("keeps a small visual gap as nav, not keyboard", () => {
    expect(splitBottomInsets(0, 32)).toEqual({ safeBottom: 32, keyboardInset: 0 });
  });

  it("treats a gap at the cap as nav", () => {
    expect(splitBottomInsets(0, NAV_GAP_CAP_PX)).toEqual({
      safeBottom: NAV_GAP_CAP_PX,
      keyboardInset: 0,
    });
  });

  it("treats a large gap as keyboard and leaves env as nav", () => {
    expect(splitBottomInsets(24, 280)).toEqual({ safeBottom: 24, keyboardInset: 280 });
  });

  it("uses env when there is no gap", () => {
    expect(splitBottomInsets(24, 0)).toEqual({ safeBottom: 24, keyboardInset: 0 });
  });

  it("is zero when both are zero", () => {
    expect(splitBottomInsets(0, 0)).toEqual({ safeBottom: 0, keyboardInset: 0 });
  });

  it("keeps a tablet taskbar as nav even when it is taller than the old cap", () => {
    expect(splitBottomInsets(48, 96)).toEqual({ safeBottom: 96, keyboardInset: 0 });
    expect(splitBottomInsets(0, 120)).toEqual({ safeBottom: 120, keyboardInset: 0 });
  });

  it("does not treat the keyboard-min boundary as an IME", () => {
    expect(splitBottomInsets(0, KEYBOARD_GAP_MIN_PX)).toEqual({
      safeBottom: KEYBOARD_GAP_MIN_PX,
      keyboardInset: 0,
    });
  });
});

describe("combineTopInset", () => {
  it("takes the largest measured source", () => {
    expect(combineTopInset(12, 24, 36)).toBe(36);
    expect(combineTopInset(24, 0, 0)).toBe(24);
    expect(combineTopInset(0, 16, 0)).toBe(16);
  });

  it("is zero when nothing measured and this is not Android", () => {
    expect(combineTopInset(0, 0, 0)).toBe(0);
    expect(combineTopInset(0, 0, 0, { android: false })).toBe(0);
  });

  it("falls back on Android until native has answered", () => {
    expect(combineTopInset(0, 0, 0, { android: true })).toBe(ANDROID_STATUS_FALLBACK_PX);
    expect(combineTopInset(0, 0, 0, { android: true, nativeKnown: false })).toBe(
      ANDROID_STATUS_FALLBACK_PX,
    );
  });

  it("trusts a native zero once Android has answered", () => {
    expect(combineTopInset(0, 0, 0, { android: true, nativeKnown: true })).toBe(0);
  });
});
