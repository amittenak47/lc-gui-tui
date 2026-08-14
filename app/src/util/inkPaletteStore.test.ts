import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearInkOverride,
  clearInkOverrides,
  defaultSwatches,
  loadInkOverrides,
  resolveSwatches,
  setInkOverride,
} from "./inkPaletteStore";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("resolveSwatches", () => {
  it("is the authored palette when nothing has been changed", () => {
    expect(resolveSwatches("light", {})).toEqual([...defaultSwatches("light")]);
  });

  it("replaces only the slot that was overridden", () => {
    const defaults = defaultSwatches("light");
    const out = resolveSwatches("light", { 2: "#123456" });
    expect(out[2]).toBe("#123456");
    expect(out[0]).toBe(defaults[0]);
    expect(out).toHaveLength(defaults.length);
  });
});

describe("setInkOverride", () => {
  it("keeps light and dark palettes apart", () => {
    setInkOverride("light", 0, "#111111");
    expect(loadInkOverrides("dark")).toEqual({});
    expect(loadInkOverrides("light")).toEqual({ 0: "#111111" });
  });

  it("treats setting a slot back to its default as a reset", () => {
    setInkOverride("light", 1, "#abcdef");
    setInkOverride("light", 1, defaultSwatches("light")[1]);
    // Not stored as an override, so a future change to the authored palette
    // still reaches this slot.
    expect(loadInkOverrides("light")).toEqual({});
  });

  it("refuses a slot that does not exist and a value that is not a colour", () => {
    setInkOverride("light", 99, "#ffffff");
    setInkOverride("light", 0, "rebeccapurple");
    expect(loadInkOverrides("light")).toEqual({});
  });

  it("survives a corrupt stored palette", () => {
    localStorage.setItem("whiteboard.ink.palette.v1", '{"light":{"0":42,"9":"#fff"},"dark":null}');
    expect(loadInkOverrides("light")).toEqual({});
    expect(loadInkOverrides("dark")).toEqual({});
  });
});

describe("clearing", () => {
  it("brings one slot's default back", () => {
    setInkOverride("dark", 3, "#0f0f0f");
    clearInkOverride("dark", 3);
    expect(resolveSwatches("dark", loadInkOverrides("dark"))).toEqual([
      ...defaultSwatches("dark"),
    ]);
  });

  it("brings the whole palette back without touching the other mode", () => {
    setInkOverride("light", 0, "#101010");
    setInkOverride("dark", 0, "#202020");
    clearInkOverrides("light");
    expect(loadInkOverrides("light")).toEqual({});
    expect(loadInkOverrides("dark")).toEqual({ 0: "#202020" });
  });
});
