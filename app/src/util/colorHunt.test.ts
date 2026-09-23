import { afterEach, describe, expect, it, vi } from "vitest";

import { chooseFeedPalette, hasVividInk, palettesFromFeed } from "./colorHunt";

afterEach(() => vi.restoreAllMocks());

describe("palettesFromFeed", () => {
  it("parses ColorHunt JSON even when the Content-Type is HTML", () => {
    const body = JSON.stringify([
      { code: "83e4b53ec8ac4e90a46e60a0", likes: "1", date: "1 year" },
    ]);
    expect(palettesFromFeed(body)).toEqual([
      ["#83e4b5", "#3ec8ac", "#4e90a4", "#6e60a0"],
    ]);
  });

  it("returns nothing for a Cloudflare HTML challenge", () => {
    expect(palettesFromFeed("<!doctype html><html><body>blocked</body></html>")).toEqual(
      [],
    );
  });
  it("ignores valid JSON error objects and non-string codes", () => {
    expect(palettesFromFeed('{"error":"busy"}')).toEqual([]);
    expect(palettesFromFeed([{ code: 123 }, null])).toEqual([]);
  });
  it("breaks a muted run in Any without changing the supplied colors", () => {
    const muted = ["#232323", "#b8b8ce", "#efe2ed", "#d4e7de"];
    const vivid = ["#ff3344", "#ffd600", "#16bd69", "#2979ff"];
    expect(hasVividInk(muted)).toBe(false);
    expect(hasVividInk(vivid)).toBe(true);
    expect(chooseFeedPalette({ items: [muted], index: 0 }, [muted, vivid], true)).toBe(vivid);
  });
  it("samples the fresh response pool and honors an explicit muted tag", () => {
    const a = ["#223344", "#ddccdd"], b = ["#111111", "#eeeeee"], c = ["#ff0044", "#00ee99"];
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(chooseFeedPalette({ items: [a], index: 0 }, [a, b, c], false)).toBe(b);
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(chooseFeedPalette({ items: [a], index: 0 }, [a, b, c], false)).toBe(c);
  });
});
