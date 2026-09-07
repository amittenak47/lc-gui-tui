/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INK_PERF_OVERLAY_EVENT,
  loadInkPerfBar,
  loadInkPerfOverlay,
  saveInkPerfBar,
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

  it("keeps the load bar with a legacy overlay-on device", () => {
    saveInkPerfOverlay(true);
    expect(loadInkPerfBar()).toBe(true);
    saveInkPerfBar(false);
    expect(loadInkPerfBar()).toBe(false);
    expect(loadInkPerfOverlay()).toBe(true);
  });

  it("notifies the board when the bar toggle changes", () => {
    let n = 0;
    const on = () => {
      n += 1;
    };
    window.addEventListener(INK_PERF_OVERLAY_EVENT, on);
    saveInkPerfBar(true);
    window.removeEventListener(INK_PERF_OVERLAY_EVENT, on);
    expect(n).toBe(1);
  });
});
