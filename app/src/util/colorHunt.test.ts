import { describe, expect, it } from "vitest";

import { palettesFromFeed } from "./colorHunt";

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
});
