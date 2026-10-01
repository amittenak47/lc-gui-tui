import { expect, it } from "vitest";

import { markdownCacheKey, sourceDigest } from "./markdownHtmlCache";

it("gives the same text the same key, and any edit a different one", () => {
  const text = "# Notes\n\n$x^2$ and some prose.";
  expect(sourceDigest(text)).toBe(sourceDigest(`${text}`));
  expect(sourceDigest(text)).not.toBe(sourceDigest(`${text} `));
  expect(sourceDigest(text)).not.toBe(sourceDigest(text.replace("x^2", "x^3")));
  // Same length, one character swapped.
  expect(sourceDigest("abcd")).not.toBe(sourceDigest("abdc"));
});

it("ties the key to the renderer, so a library upgrade renders afresh", () => {
  expect(markdownCacheKey("# Notes")).toMatch(/^\d+:[^:]+:[^:]+\x1f/);
});

it("drops the least recently opened renders first, by count and by size", async () => {
  const { rendersToDrop, MD_HTML_KEEP, MD_HTML_MAX_CHARS } = await import("./markdownHtmlCache");
  const keys = Array.from({ length: MD_HTML_KEEP + 3 }, (_, i) => `k${i}`);
  const uses = new Map(keys.map((k, i) => [k, { usedAt: i, chars: 10 }]));
  // The oldest three go once the count is over.
  expect(rendersToDrop(keys, uses).sort()).toEqual(["k0", "k1", "k2"]);
  // One render opened just now stays, whatever else is newer by writing.
  uses.set("k0", { usedAt: 999, chars: 10 });
  expect(rendersToDrop(keys, uses)).not.toContain("k0");
  // Size binds before count: two huge renders cannot both stay.
  const big = new Map([["a", { usedAt: 2, chars: MD_HTML_MAX_CHARS * 0.6 }], ["b", { usedAt: 1, chars: MD_HTML_MAX_CHARS * 0.6 }]]);
  expect(rendersToDrop(["a", "b"], big)).toEqual(["b"]);
  // A render with no index row predates it and goes first.
  expect(rendersToDrop(["new", "old"], new Map([["new", { usedAt: 5, chars: 10 }]]))).toEqual(["old"]);
});
