/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INK_SPLINE_GRADIENT_DEFAULT,
  INK_SPLINE_OUTLINE_DEFAULT,
  loadInkSplineGradient,
  loadInkSplineOutline,
  saveInkSplineGradient,
  saveInkSplineOutline,
} from "./inkSplinePref";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("inkSplinePref", () => {
  it("defaults both knobs off", () => {
    expect(loadInkSplineOutline()).toBe(INK_SPLINE_OUTLINE_DEFAULT);
    expect(loadInkSplineGradient()).toBe(INK_SPLINE_GRADIENT_DEFAULT);
    expect(INK_SPLINE_OUTLINE_DEFAULT).toBe(false);
    expect(INK_SPLINE_GRADIENT_DEFAULT).toBe(false);
  });

  it("round-trips the outline flag", () => {
    saveInkSplineOutline(true);
    expect(loadInkSplineOutline()).toBe(true);
    saveInkSplineOutline(false);
    expect(loadInkSplineOutline()).toBe(false);
  });

  it("round-trips the gradient flag", () => {
    saveInkSplineGradient(true);
    expect(loadInkSplineGradient()).toBe(true);
  });
});
