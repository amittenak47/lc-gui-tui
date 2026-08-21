import { describe, expect, it } from "vitest";

import { scopeCss } from "./webPageCss";
import {
  cssColorLuminance,
  dropBlankPaper,
  isBlankPaperBackground,
  targetsDocRoot,
} from "./webPagePaper";

describe("cssColorLuminance", () => {
  it("reads hex, short hex and rgb", () => {
    expect(cssColorLuminance("#fff")).toBeCloseTo(1, 5);
    expect(cssColorLuminance("#000000")).toBeCloseTo(0, 5);
    expect(cssColorLuminance("rgb(255, 255, 255)")).toBeCloseTo(1, 5);
    expect(cssColorLuminance("rgba(0 0 0 / 50%)")).toBeCloseTo(0, 5);
  });

  it("is null for anything that is not a plain colour", () => {
    expect(cssColorLuminance("linear-gradient(red, blue)")).toBeNull();
    expect(cssColorLuminance("var(--bg)")).toBeNull();
    expect(cssColorLuminance("")).toBeNull();
  });
});

describe("isBlankPaperBackground", () => {
  it("treats white and near-white as blank", () => {
    expect(isBlankPaperBackground("#fff")).toBe(true);
    expect(isBlankPaperBackground(" #FAFAFA ")).toBe(true);
    expect(isBlankPaperBackground("white")).toBe(true);
    expect(isBlankPaperBackground("transparent")).toBe(true);
    expect(isBlankPaperBackground("#fff !important")).toBe(true);
  });

  it("keeps a page's real colour", () => {
    // Dropping this would leave the site's own light text on light paper.
    expect(isBlankPaperBackground("#0b0b0f")).toBe(false);
    expect(isBlankPaperBackground("rgb(20, 30, 40)")).toBe(false);
    expect(isBlankPaperBackground("#1a73e8")).toBe(false);
  });

  it("keeps images and gradients whatever colour they resolve to", () => {
    expect(isBlankPaperBackground("url(bg.png)")).toBe(false);
    expect(isBlankPaperBackground("linear-gradient(#fff, #fff)")).toBe(false);
    expect(isBlankPaperBackground("#fff url(x.png) no-repeat")).toBe(false);
  });
});

describe("dropBlankPaper", () => {
  it("removes only the blank background", () => {
    expect(dropBlankPaper("color:#111;background:#fff;margin:0")).toBe(
      "color:#111;margin:0",
    );
  });

  it("leaves a body that has nothing to drop untouched", () => {
    const body = "color:#111;margin:0";
    expect(dropBlankPaper(body)).toBe(body);
  });

  it("does not cut a declaration in half inside a function", () => {
    const body = 'background:url("a;b.png");color:#111';
    expect(dropBlankPaper(body)).toBe(body);
  });

  it("handles background-color as well as the shorthand", () => {
    expect(dropBlankPaper("background-color:#ffffff")).toBe("");
  });
});

describe("targetsDocRoot", () => {
  it("is true when a comma part is the container itself", () => {
    expect(targetsDocRoot(".lc-web-doc,.lc-web-doc .x", ".lc-web-doc")).toBe(true);
  });

  it("is false for descendants only", () => {
    expect(targetsDocRoot(".lc-web-doc .x,.lc-web-doc .y", ".lc-web-doc")).toBe(false);
  });
});

describe("scopeCss end to end", () => {
  it("lets the theme through a page that paints itself white", () => {
    // This is the whole bug: `body{background:#fff}` becomes a rule on the
    // container, and an opaque sheet lands over the pad's paper.
    const out = scopeCss("body{background:#fff;color:#111}");
    expect(out).toContain(".lc-web-doc{");
    expect(out).not.toContain("#fff");
    expect(out).toContain("color:#111");
  });

  it("keeps a dark page dark", () => {
    const out = scopeCss("body{background:#0b0b0f;color:#eee}");
    expect(out).toContain("#0b0b0f");
  });

  it("leaves inner elements alone", () => {
    const out = scopeCss(".card{background:#fff}");
    expect(out).toContain("#fff");
  });
});
