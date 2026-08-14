import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isLinedPaperMode,
  linedPaperLabel,
  linedPaperScreenPx,
  loadLinedPaperMode,
  nextLinedPaperMode,
  saveLinedPaperMode,
  LINED_PAPER_COLLEGE_SCREEN_PX,
  LINED_PAPER_WIDE_SCREEN_PX,
} from "./linedPaperPref";

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

describe("lined paper cycle", () => {
  it("goes off → wide → college → off", () => {
    expect(nextLinedPaperMode("off")).toBe("wide");
    expect(nextLinedPaperMode("wide")).toBe("college");
    expect(nextLinedPaperMode("college")).toBe("off");
  });

  it("keeps the original 36px gap for wide, and a tighter college gap", () => {
    expect(linedPaperScreenPx("wide")).toBe(LINED_PAPER_WIDE_SCREEN_PX);
    expect(linedPaperScreenPx("college")).toBe(LINED_PAPER_COLLEGE_SCREEN_PX);
    expect(linedPaperScreenPx("college")).toBeLessThan(LINED_PAPER_WIDE_SCREEN_PX);
    expect(linedPaperScreenPx("off")).toBe(0);
  });

  it("names each mode for the button", () => {
    expect(linedPaperLabel("wide")).toBe("Wide lined paper");
    expect(linedPaperLabel("college")).toBe("College lined paper");
    expect(linedPaperLabel("off")).toBe("No lined paper");
  });

  it("rejects a stored value that is not a mode", () => {
    expect(isLinedPaperMode("wide")).toBe(true);
    expect(isLinedPaperMode("true")).toBe(false);
    expect(isLinedPaperMode(null)).toBe(false);
  });
});

describe("lined paper persist", () => {
  it("defaults to off, matching the old boolean", () => {
    expect(loadLinedPaperMode()).toBe("off");
  });

  it("round-trips every mode", () => {
    for (const mode of ["off", "wide", "college"] as const) {
      saveLinedPaperMode(mode);
      expect(loadLinedPaperMode()).toBe(mode);
    }
  });

  it("falls back when the stored value is not one we know", () => {
    localStorage.setItem("whiteboard.linedPaper.v1", "legal");
    expect(loadLinedPaperMode()).toBe("off");
  });
});
