/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  autosaveBannerAllowed,
  coalesceAutosaveNotice,
  loadAutosaveBanner,
  saveAutosaveBanner,
} from "./autosavePref";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("autosave banners", () => {
  it("defaults to on, and persists Hide", () => {
    expect(loadAutosaveBanner()).toBe("on");
    saveAutosaveBanner("off");
    expect(loadAutosaveBanner()).toBe("off");
  });

  it("lets the focused pad and a split partner speak, not a parked chip", () => {
    expect(autosaveBannerAllowed("a", ["a"])).toBe(true);
    expect(autosaveBannerAllowed("b", ["a", "b"])).toBe(true);
    expect(autosaveBannerAllowed("parked", ["a"])).toBe(false);
  });

  it("keeps the first Saved line when a split partner saves too", () => {
    const first = coalesceAutosaveNotice(null, "Notes", true);
    expect(first).toBe("Saved.");
    expect(coalesceAutosaveNotice(first, "Doodle", true)).toBe("Saved.");
  });

  it("names a solo pad, and does not replace an existing Saved banner", () => {
    expect(coalesceAutosaveNotice(null, "Notes", false)).toBe("Saved “Notes”.");
    expect(coalesceAutosaveNotice("Saved “Notes”.", "Other", false)).toBe("Saved “Notes”.");
  });
});
