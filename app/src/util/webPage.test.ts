import { describe, expect, it } from "vitest";

import { PAGE_MAX_BYTES, WEB_HOME, absolutizeUrl, hostLabelFromUrl, titleFromHtml, webPageWidthForViewport } from "./webPage";

describe("webPage", () => {
  it("keeps the Google homepage constant", () => {
    expect(WEB_HOME).toBe("https://www.google.com/");
  });

  it("resolves relative URLs against the snapshot origin", () => {
    expect(absolutizeUrl("https://www.google.com/", "/search?q=lc")).toBe(
      "https://www.google.com/search?q=lc",
    );
  });

  it("reads the HTML title", () => {
    expect(titleFromHtml("<html><title> Google </title></html>")).toBe("Google");
  });

  it("caps inlined capture HTML at 8MB", () => {
    expect(PAGE_MAX_BYTES).toBe(8_000_000);
  });

  it("sizes the web pad to the window, not the markdown column", () => {
    expect(webPageWidthForViewport(1920)).toBeGreaterThan(1280);
    expect(webPageWidthForViewport(1920)).toBeLessThanOrEqual(2400);
    expect(webPageWidthForViewport(400)).toBeLessThan(500);
  });

  it("shortens a page URL to the host for the header", () => {
    expect(
      hostLabelFromUrl(
        "https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/",
      ),
    ).toBe("developer.nvidia.com");
    expect(hostLabelFromUrl("https://www.google.com/")).toBe("google.com");
    expect(hostLabelFromUrl("not a url")).toBe("not a url");
  });
});
