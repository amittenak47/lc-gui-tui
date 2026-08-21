import { describe, expect, it } from "vitest";

import { findQuote, QUOTE_CONTEXT_CHARS, quoteFromStream } from "./quoteAnchor";

describe("quoteFromStream", () => {
  it("takes the words and their surroundings", () => {
    const text = "before the marked words after";
    const q = quoteFromStream(text, 11, 23)!;
    expect(q.exact).toBe("marked words");
    expect(q.prefix).toBe("before the ");
    expect(q.suffix).toBe(" after");
  });

  it("caps the context it keeps", () => {
    const text = `${"a".repeat(200)}QUOTE${"b".repeat(200)}`;
    const q = quoteFromStream(text, 200, 205)!;
    expect(q.exact).toBe("QUOTE");
    expect(q.prefix).toHaveLength(QUOTE_CONTEXT_CHARS);
    expect(q.suffix).toHaveLength(QUOTE_CONTEXT_CHARS);
  });

  it("has no context to offer at the very edges", () => {
    const q = quoteFromStream("edge", 0, 4)!;
    expect(q.exact).toBe("edge");
    expect(q.prefix).toBeUndefined();
    expect(q.suffix).toBeUndefined();
  });

  it("refuses a selection that is only whitespace", () => {
    expect(quoteFromStream("a    b", 1, 5)).toBeNull();
    expect(quoteFromStream("abc", 2, 2)).toBeNull();
    expect(quoteFromStream("abc", 0, 99)).toBeNull();
  });
});

describe("findQuote", () => {
  it("finds the phrase in its original surroundings", () => {
    const now = "some new heading, then before the marked words after, and more";
    const found = findQuote(now, {
      exact: "marked words",
      prefix: "before the ",
      suffix: " after",
    })!;
    expect(now.slice(found.start, found.end)).toBe("marked words");
  });

  it("finds a unique phrase even when the surroundings changed", () => {
    // The page was edited around it; the words themselves survived.
    const found = findQuote("completely rewritten marked words completely rewritten", {
      exact: "marked words",
      prefix: "nothing like this any more ",
      suffix: " nor this",
    })!;
    expect(found.start).toBe("completely rewritten ".length);
  });

  it("picks the occurrence the context identifies", () => {
    /*
     * The reason prefix and suffix are stored at all: "Sign in" appears forty
     * times on a page, and the words either side are what tell the one you meant
     * from the other thirty-nine.
     */
    const text = "alpha Sign in beta ... gamma Sign in delta";
    const found = findQuote(text, { exact: "Sign in", prefix: "gamma ", suffix: " delta" })!;
    expect(found.start).toBe(text.lastIndexOf("Sign in"));
  });

  it("admits a miss rather than guessing between identical twins", () => {
    // Nothing distinguishes them, so any answer would be a coin flip presented
    // as a fact — and a mark on the wrong words is worse than one that says the
    // words are gone.
    const text = "Sign in ... Sign in";
    expect(findQuote(text, { exact: "Sign in" })).toBeNull();
  });

  it("says nothing when the words are genuinely gone", () => {
    // Tomorrow's feed. This is the case that must not silently succeed.
    expect(findQuote("an entirely different page", { exact: "marked words" })).toBeNull();
  });

  it("gives up on a phrase repeated past all hope of disambiguation", () => {
    /*
     * A page of near-identical rows: the surroundings repeat as faithfully as
     * the phrase, so matching them proves nothing. Requiring the context to be
     * *unique* rather than merely present is what stops this returning the
     * first row as though it were the right one.
     */
    const text = "x ".repeat(500);
    expect(findQuote(text, { exact: "x", prefix: "x ", suffix: " x" })).toBeNull();
  });

  it("refuses a context that matches in two places", () => {
    const text = "left MARK right ... left MARK right";
    expect(findQuote(text, { exact: "MARK", prefix: "left ", suffix: " right" })).toBeNull();
  });

  it("has nothing to find without an exact", () => {
    expect(findQuote("anything", { exact: "" })).toBeNull();
  });
});
