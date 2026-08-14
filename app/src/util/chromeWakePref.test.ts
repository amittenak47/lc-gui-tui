import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chromeWakeMarkerLabel,
  isChromeWakeMarker,
  loadChromeWakeMarker,
  saveChromeWakeMarker,
} from "./chromeWakePref";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("chrome wake marker", () => {
  it("defaults to the current smear", () => {
    expect(loadChromeWakeMarker()).toBe("smear");
  });

  it("round-trips every marker", () => {
    for (const marker of ["smear", "pulse", "off"] as const) {
      saveChromeWakeMarker(marker);
      expect(loadChromeWakeMarker()).toBe(marker);
    }
  });

  it("falls back when the stored value is not one we know", () => {
    localStorage.setItem("whiteboard.chromeWake.v1", "glow");
    expect(loadChromeWakeMarker()).toBe("smear");
  });

  it("rejects a stored value that is not a marker", () => {
    expect(isChromeWakeMarker("pulse")).toBe(true);
    expect(isChromeWakeMarker("true")).toBe(false);
    expect(isChromeWakeMarker(null)).toBe(false);
  });

  it("names each marker for Settings", () => {
    expect(chromeWakeMarkerLabel("smear")).toBe("Grey smear");
    expect(chromeWakeMarkerLabel("pulse")).toBe("Checkerboard pulse");
    expect(chromeWakeMarkerLabel("off")).toBe("Hidden");
  });
});
