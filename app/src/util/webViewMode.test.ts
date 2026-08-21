/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWebViewMode, opensLive, saveWebViewMode } from "./webViewMode";

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

describe("web view mode", () => {
  it("remembers the choice across pages", () => {
    // The bug: this reset every time a browser tab opened, so choosing the live
    // view was a choice you had to make again on every page.
    saveWebViewMode("frozen");
    expect(loadWebViewMode()).toBe("frozen");
    saveWebViewMode("live");
    expect(loadWebViewMode()).toBe("live");
  });

  it("ignores a stored value it does not recognise", () => {
    localStorage.setItem("whiteboard.webViewMode.v1", "sideways");
    expect(loadWebViewMode()).toBe("live");
  });
});

describe("opensLive", () => {
  it("honours the preference on a page with no marks", () => {
    expect(opensLive({ supported: true, hasMarks: false, preference: "live" })).toBe(true);
    expect(opensLive({ supported: true, hasMarks: false, preference: "frozen" })).toBe(false);
  });

  it("lets marks win over the preference", () => {
    /*
     * Marks live on the frozen copy, so opening live would show a page with the
     * reader's own annotations invisible on it — the one outcome nobody wants
     * from either setting.
     */
    expect(opensLive({ supported: true, hasMarks: true, preference: "live" })).toBe(false);
  });

  it("never opens live where a live pane cannot exist", () => {
    expect(opensLive({ supported: false, hasMarks: false, preference: "live" })).toBe(false);
  });
});
