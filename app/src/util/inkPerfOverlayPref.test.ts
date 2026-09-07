/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INK_PERF_OVERLAY_EVENT,
  loadInkPerfOverlay,
  saveInkPerfOverlay,
} from "./inkPerfOverlayPref";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => void store.clear(),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("inkPerfOverlayPref", () => {
  it("is off until turned on", () => {
    expect(loadInkPerfOverlay()).toBe(false);
    saveInkPerfOverlay(true);
    expect(loadInkPerfOverlay()).toBe(true);
    saveInkPerfOverlay(false);
    expect(loadInkPerfOverlay()).toBe(false);
  });

  it("notifies the board when the toggle changes", () => {
    let n = 0;
    const on = () => {
      n += 1;
    };
    window.addEventListener(INK_PERF_OVERLAY_EVENT, on);
    saveInkPerfOverlay(true);
    window.removeEventListener(INK_PERF_OVERLAY_EVENT, on);
    expect(n).toBe(1);
  });
});
