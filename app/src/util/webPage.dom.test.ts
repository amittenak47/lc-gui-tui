/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { flattenWebSnapshot, sanitizeWebHtml } from "./webPage";

describe("flattenWebSnapshot", () => {
  it("unwraps a single generic shell so blocks sit on the paper", () => {
    const holder = document.createElement("div");
    holder.innerHTML = `<div id="wrap"><p>one</p><p>two</p></div>`;
    flattenWebSnapshot(holder);
    expect(holder.children).toHaveLength(2);
    expect(holder.children[0].tagName).toBe("P");
  });

  it("stops on a real block", () => {
    const holder = document.createElement("div");
    holder.innerHTML = `<p>keep</p>`;
    flattenWebSnapshot(holder);
    expect(holder.children).toHaveLength(1);
    expect(holder.children[0].tagName).toBe("P");
  });
});

describe("sanitizeWebHtml", () => {
  it("drops hidden chrome and keeps a stylesheet hook", () => {
    const html = sanitizeWebHtml(
      `<html><body>
        <div hidden>junk</div>
        <style>.x{color:red}</style>
        <p class="x">hi</p>
      </body></html>`,
      "https://example.com/",
    );
    expect(html).not.toMatch(/junk/);
    expect(html).toMatch(/<style>/i);
    expect(html).toMatch(/<p/);
  });

  it("pins fixed chrome so it cannot cover the board", () => {
    const html = sanitizeWebHtml(
      `<div style="position:fixed;top:0">nav</div><p>body</p>`,
      "https://example.com/",
    );
    expect(html).toMatch(/position:\s*static/i);
    expect(html).not.toMatch(/position:\s*fixed/i);
  });
});
