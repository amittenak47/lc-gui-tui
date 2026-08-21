/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WEB_RENDER_MODE,
  isWebRenderMode,
  loadWebRenderMode,
  otherWebRenderMode,
  saveWebRenderMode,
} from "./webRenderMode";

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

describe("webRenderMode", () => {
  it("starts on reader", () => {
    // Articles are the common case and Reader is much better for them; the
    // point of the setting is that it can be turned off and stay off.
    expect(loadWebRenderMode()).toBe("reader");
    expect(DEFAULT_WEB_RENDER_MODE).toBe("reader");
  });

  it("remembers the choice across pages", () => {
    saveWebRenderMode("page");
    expect(loadWebRenderMode()).toBe("page");
  });

  it("ignores a stored value it does not recognise", () => {
    localStorage.setItem("whiteboard.webRenderMode.v1", "cheese");
    expect(loadWebRenderMode()).toBe("reader");
  });

  it("toggles both ways", () => {
    expect(otherWebRenderMode("reader")).toBe("page");
    expect(otherWebRenderMode("page")).toBe("reader");
  });

  it("guards the type", () => {
    expect(isWebRenderMode("reader")).toBe(true);
    expect(isWebRenderMode("page")).toBe(true);
    expect(isWebRenderMode(null)).toBe(false);
  });
});
