import { describe, expect, it } from "vitest";

import { withArticleTitle } from "./webReader";

describe("withArticleTitle", () => {
  it("puts the headline and source above the body", () => {
    // Readability returns the article body only, so reader view opened on the
    // first paragraph with nothing saying what you were reading.
    const out = withArticleTitle("<p>Body.</p>", "Requirements", "https://www.example.com/p/x");
    expect(out).toBe(
      '<h1>Requirements</h1><p class="lc-reader-source">example.com</p><p>Body.</p>',
    );
  });

  it("does not add a second headline", () => {
    const html = "<h1>Already here</h1><p>Body.</p>";
    expect(withArticleTitle(html, "Already here", "https://example.com")).toBe(html);
  });

  it("ignores leading whitespace when looking for one", () => {
    const html = "\n  <h1>Here</h1><p>x</p>";
    expect(withArticleTitle(html, "Here", "https://example.com")).toBe(html);
  });

  it("is not fooled by an h1-ish tag name", () => {
    const html = "<h1x>Not a heading</h1x>";
    expect(withArticleTitle(html, "T", "https://example.com")).toContain("<h1>T</h1>");
  });

  it("escapes the title rather than injecting it", () => {
    const out = withArticleTitle("<p>x</p>", '<img src=x onerror="alert(1)">', "https://e.com");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("adds nothing when there is no title", () => {
    expect(withArticleTitle("<p>x</p>", "   ", "https://example.com")).toBe("<p>x</p>");
  });

  it("survives a url it cannot parse", () => {
    const out = withArticleTitle("<p>x</p>", "T", "not a url");
    expect(out).toBe("<h1>T</h1><p>x</p>");
  });
});
