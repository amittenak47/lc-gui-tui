import { describe, expect, it } from "vitest";

import { PAGE_MAX_BYTES, WEB_HOME, absolutizeUrl, titleFromHtml } from "./webPage";

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
});
