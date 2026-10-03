import { afterEach, describe, expect, it, vi } from "vitest";

import { chooseFeedPalette, createColorHuntSource, hasVividInk, palettesFromFeed, poolFeedPalettes } from "./colorHunt";
import { normalizePalettePrefs } from "./palettePref";
import { paletteContrast, paletteDeltaE } from "./paletteMix";

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

const neon = ["#dd0033", "#aa0088", "#1166dd", "#009955"];
const dark = ["#102030", "#203040", "#304050", "#405060"];
const history = () => ({ items: [] as string[][], index: 0 });
it("pools without duplicate codes and alternates tags without repeating history", async () => {
  expect(poolFeedPalettes([[neon], [neon, dark]])).toEqual([neon, dark]);
  const neon2 = ["#cc0022", "#990077", "#0055cc", "#008844"];
  const dark2 = ["#112233", "#223344", "#334455", "#445566"];
  const fetchFeed = vi.fn(async query => query === "neon" ? [neon, neon2] : [dark, dark2]);
  const source = createColorHuntSource(fetchFeed, { random: () => 0 });
  const prefs = normalizePalettePrefs(["neon", "dark"]), used = history();
  for (const expected of [neon, dark, neon2, dark2]) {
    const palette = await source.next(used, prefs);
    expect(palette).toEqual(expected); used.items.push(palette);
  }
  expect(fetchFeed.mock.calls.map(([query]) => query)).toEqual(["neon", "dark"]);
});
it("tries an intersection then falls back to a pool, preserving successful tags", async () => {
  const fetchFeed = vi.fn(async query => {
    if (query === "neon-dark") return [];
    if (query === "dark") throw new Error("offline");
    return [neon];
  });
  const prefs = { ...normalizePalettePrefs(["neon", "dark"]), matchAll: true };
  expect(await createColorHuntSource(fetchFeed).next(history(), prefs)).toEqual(neon);
  expect(fetchFeed.mock.calls.map(([query]) => query)).toEqual(["neon-dark", "neon", "dark"]);
  const combined = vi.fn(async () => [dark]);
  expect(await createColorHuntSource(combined).next(history(), prefs)).toEqual(dark);
  expect(combined).toHaveBeenCalledOnce();
});
it("expires cached pages and never has more than four feed requests in flight", async () => {
  let now = 0, active = 0, max = 0;
  const fetchFeed = vi.fn(async () => {
    max = Math.max(max, ++active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return [neon];
  });
  const source = createColorHuntSource(fetchFeed, { now: () => now });
  const prefs = normalizePalettePrefs(["neon", "dark", "cold", "earth", "sunset", "space"]);
  await source.next(history(), prefs); expect(max).toBe(4); expect(fetchFeed).toHaveBeenCalledTimes(6);
  now = 170_000; await source.next(history(), prefs); expect(fetchFeed).toHaveBeenCalledTimes(6);
  now = 181_000; await source.next(history(), prefs); expect(fetchFeed).toHaveBeenCalledTimes(12);
});
it("refreshes an exhausted page and mixes safe fallback colours offline", async () => {
  const fetchFeed = vi.fn(async () => [neon]);
  const source = createColorHuntSource(fetchFeed);
  const used = history(); used.items.push(neon);
  const palette = await source.next(used, "neon");
  expect(palette).not.toEqual(neon); expect(fetchFeed).toHaveBeenCalledTimes(2);
  const offline = createColorHuntSource(async () => { throw new Error("offline"); }, { random: () => .5 });
  const mixed = await offline.next(history(), { ...normalizePalettePrefs("any"), mixColours: true });
  expect(mixed).toHaveLength(4); expect(hasVividInk(mixed)).toBe(true);
  for (let i = 0; i < 4; i++) {
    expect(paletteContrast(mixed[i]!, "#ffffff")).toBeGreaterThanOrEqual(2);
    for (let j = i + 1; j < 4; j++) expect(paletteDeltaE(mixed[i]!, mixed[j]!)).toBeGreaterThanOrEqual(12);
  }
});
