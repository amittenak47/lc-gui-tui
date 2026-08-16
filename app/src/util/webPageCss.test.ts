import { describe, expect, it } from "vitest";

import { absolutizeCssUrls, prefixSelectors, scopeCss } from "./webPageCss";

describe("scopeCss", () => {
  it("rewrites body/html/:root onto the paper so they cannot paint the app", () => {
    const out = scopeCss(
      "html { background:#fff } body { color:#111 } :root { --x:1 } header { border-top:4px solid #fff }",
    );
    expect(out).toMatch(/\.lc-web-doc\s*\{[^}]*background:#fff/);
    expect(out).toMatch(/\.lc-web-doc\s*\{[^}]*color:#111/);
    expect(out).toMatch(/\.lc-web-doc\s*\{[^}]*--x:1/);
    expect(out).toMatch(/\.lc-web-doc header\s*\{/);
    expect(out).not.toMatch(/(^|})\s*body\s*\{/);
    expect(out).not.toMatch(/(^|})\s*html\s*\{/);
    expect(out).not.toMatch(/(^|})\s*:root\s*\{/);
  });

  it("prefixes descendants and pins fixed chrome", () => {
    const out = scopeCss(".share { position:fixed; width:100vw } .article p { color:red }");
    expect(out).toMatch(/\.lc-web-doc \.share\s*\{/);
    expect(out).toMatch(/position:static/);
    expect(out).not.toMatch(/position:\s*fixed/i);
    expect(out).toMatch(/width:100%/);
    expect(out).toMatch(/\.lc-web-doc \.article p\s*\{/);
  });

  it("walks @media and leaves @keyframes", () => {
    const out = scopeCss(
      "@media (min-width:1px){ .foo { color:blue } } @keyframes spin { from { opacity:0 } to { opacity:1 } }",
    );
    expect(out).toMatch(/@media \(min-width:1px\)\{\s*\.lc-web-doc \.foo\s*\{/);
    expect(out).toMatch(/@keyframes spin \{ from \{ opacity:0 \} to \{ opacity:1 \} \}/);
  });

  it("is idempotent", () => {
    const once = scopeCss("body { color:red }");
    expect(scopeCss(once)).toBe(once);
  });
});

describe("prefixSelectors", () => {
  it("maps html body onto the scope", () => {
    expect(prefixSelectors("html body .nav").trim()).toBe(".lc-web-doc .nav");
    expect(prefixSelectors("body.home .x").trim()).toBe(".lc-web-doc.home .x");
  });
});

describe("absolutizeCssUrls", () => {
  it("resolves relative urls", () => {
    expect(absolutizeCssUrls("a{background:url(/i.png)}", "https://ex.com/blog/")).toBe(
      "a{background:url(https://ex.com/i.png)}",
    );
  });
});
