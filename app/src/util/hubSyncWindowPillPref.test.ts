/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HUB_SYNC_WINDOW_PILL_EVENT,
  loadHubSyncWindowPill,
  saveHubSyncWindowPill,
} from "./hubSyncWindowPillPref";

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

describe("hubSyncWindowPillPref", () => {
  it("is off until turned on", () => {
    expect(loadHubSyncWindowPill()).toBe(false);
    saveHubSyncWindowPill(true);
    expect(loadHubSyncWindowPill()).toBe(true);
    saveHubSyncWindowPill(false);
    expect(loadHubSyncWindowPill()).toBe(false);
  });

  it("notifies the workspace when the toggle changes", () => {
    let n = 0;
    const on = () => {
      n += 1;
    };
    window.addEventListener(HUB_SYNC_WINDOW_PILL_EVENT, on);
    saveHubSyncWindowPill(true);
    window.removeEventListener(HUB_SYNC_WINDOW_PILL_EVENT, on);
    expect(n).toBe(1);
  });
});
