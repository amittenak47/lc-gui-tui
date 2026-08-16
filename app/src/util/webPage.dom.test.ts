/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { flattenWebSnapshot, isolateWebCss, promoteLazyImages, sanitizeWebHtml } from "./webPage";

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
    expect(html).toMatch(/\.lc-web-doc \.x\{color:red\}/);
    expect(html).toMatch(/<p/);
  });

  it("drops modulepreload so remote JS never loads from our origin", () => {
    const html = sanitizeWebHtml(
      `<link rel="modulepreload" href="https://developer.nvidia.com/blog/wp-includes/js/dist/script-modules/interactivity/index.min.js?ver=efaa5193bbad9c60ffd1" />
       <link rel="preload" as="script" href="https://example.com/boot.js" />
       <link rel="stylesheet" href="https://example.com/a.css" />
       <p>hi</p>`,
      "https://developer.nvidia.com/blog/",
    );
    expect(html).not.toMatch(/modulepreload/i);
    expect(html).not.toMatch(/interactivity\/index\.min\.js/i);
    expect(html).not.toMatch(/boot\.js/);
    expect(html).toMatch(/rel="stylesheet"/i);
    expect(html).toMatch(/<p/);
  });

  it("promotes WordPress lazysizes SVG placeholders (NVIDIA blog figures)", () => {
    const placeholder =
      "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%201995%201045%22%3E%3C/svg%3E";
    const html = sanitizeWebHtml(
      `<img class="lazyload wp-image-112496" src="${placeholder}" data-src="https://developer-blogs.nvidia.com/wp-content/uploads/2026/02/image3-png.webp" data-srcset="https://developer-blogs.nvidia.com/wp-content/uploads/2026/02/image3-png.webp 1995w" data-sizes="(max-width: 1995px) 100vw, 1995px" alt="Figure 1" />`,
      "https://developer.nvidia.com/blog/",
    );
    expect(html).toMatch(/src="https:\/\/developer-blogs\.nvidia\.com\/wp-content\/uploads\/2026\/02\/image3-png\.webp"/);
    expect(html).toMatch(/srcset=/);
    expect(html).not.toMatch(/class="[^"]*lazyload/);
  });

  it("promotes lazy image src so figures paint without page JS", () => {
    const html = sanitizeWebHtml(
      `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="https://example.com/fig2.png" alt="Figure 2" />`,
      "https://example.com/",
    );
    expect(html).toMatch(/src="https:\/\/example.com\/fig2.png"/);
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

describe("isolateWebCss", () => {
  it("drops stylesheet links so they cannot style the app or fetch remotely", async () => {
    const html = await isolateWebCss(
      `<link rel="stylesheet" href="https://example.com/a.css"><p>hi</p>`,
      "https://example.com/",
    );
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/a\.css/);
    expect(html).toMatch(/<p/);
  });

  it("scopes small inline CSS and drops huge sheets", async () => {
    const small = await isolateWebCss(
      `<style>body { background:#fff } header { color:#111 }</style><p>hi</p>`,
      "https://example.com/",
    );
    expect(small).toMatch(/\.lc-web-doc\s*\{[^}]*background:#fff/);
    expect(small).toMatch(/\.lc-web-doc header/);

    const huge = "body{color:red}".repeat(20_000);
    const dropped = await isolateWebCss(`<style>${huge}</style><p>hi</p>`, "https://example.com/");
    expect(dropped).not.toMatch(/color:red/);
    expect(dropped).toMatch(/<p/);
  });
});

describe("promoteLazyImages", () => {
  it("swaps a live lazysizes node so an already-open snapshot can paint", () => {
    const holder = document.createElement("div");
    holder.innerHTML = `<img class="lazyload wp-image-112496" src="data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%201995%201045%22%3E%3C/svg%3E" data-src="https://developer-blogs.nvidia.com/wp-content/uploads/2026/02/image3-png.webp" alt="Figure 1" />`;
    promoteLazyImages(holder);
    const img = holder.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      "https://developer-blogs.nvidia.com/wp-content/uploads/2026/02/image3-png.webp",
    );
    expect(img?.classList.contains("lazyload")).toBe(false);
    expect(img?.getAttribute("src") ?? "").not.toMatch(/__lc-web-fetch/);
  });
});
