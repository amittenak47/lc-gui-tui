/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INK_DISPLAY_HZ_EVENT,
  loadInkDisplayHz,
  loadInkMatchDisplay,
  saveInkDisplayHz,
  saveInkMatchDisplay,
} from "./inkDisplayHzPref";

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

describe("inkDisplayHzPref", () => {
  it("defaults to Auto", () => {
    expect(loadInkDisplayHz()).toBe("auto");
  });

  it("stores a manual refresh and notifies the board", () => {
    let n = 0;
    const on = () => {
      n += 1;
    };
    window.addEventListener(INK_DISPLAY_HZ_EVENT, on);
    saveInkDisplayHz(90);
    window.removeEventListener(INK_DISPLAY_HZ_EVENT, on);
    expect(loadInkDisplayHz()).toBe(90);
    expect(n).toBe(1);
  });

  it("ignores junk in localStorage", () => {
    store.set("whiteboard.inkDisplayHz", "75");
    expect(loadInkDisplayHz()).toBe("auto");
  });

  it("Match display is off until saved on", () => {
    expect(loadInkMatchDisplay()).toBe(false);
    let n = 0;
    const on = () => {
      n += 1;
    };
    window.addEventListener(INK_DISPLAY_HZ_EVENT, on);
    saveInkMatchDisplay(true);
    window.removeEventListener(INK_DISPLAY_HZ_EVENT, on);
    expect(loadInkMatchDisplay()).toBe(true);
    expect(n).toBe(1);
  });
});
