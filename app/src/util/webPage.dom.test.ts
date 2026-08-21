/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

import {
  FETCH_STYLE_CAP,
  flattenWebSnapshot,
  isolateWebCss,
  promoteLazyImages,
  readerPageFromHtml,
  sanitizeWebHtml,
  styleTagStats,
} from "./webPage";

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

  it("keeps a button's shape and takes away its behaviour", () => {
    /*
     * Deleting `button` cost the snapshot its face. DOMPurify unwraps a
     * forbidden tag rather than dropping its children, so a styled call to
     * action came through as a bare glyph and a word, with the element every
     * one of the page's own rules was written against gone.
     */
    const out = sanitizeWebHtml(
      '<button class="cta"><svg viewBox="0 0 24 24"></svg><span>Start</span></button>',
      "https://example.com/",
    );
    expect(out).toContain("<button");
    expect(out).toContain('class="cta"');
    expect(out).toContain("<svg");
    expect(out).toContain('tabindex="-1"');
  });

  it("keeps an input visible and unfillable", () => {
    const out = sanitizeWebHtml(
      '<input class="q" name="q" placeholder="Search">',
      "https://example.com/",
    );
    expect(out).toContain("<input");
    expect(out).toContain('class="q"');
    expect(out).toContain("readonly");
    // Nothing left to submit under.
    expect(out).not.toContain('name="q"');
  });

  it("turns a form into a plain box, so Enter cannot send anything", () => {
    const out = sanitizeWebHtml(
      '<form class="search" action="/search" method="get"><input></form>',
      "https://example.com/",
    );
    // The form becomes a div and loses its destination. Whether that div then
    // survives is `flattenWebSnapshot`'s business — it unwraps lone wrappers
    // either way, and has done since before this.
    expect(out).not.toContain("<form");
    expect(out).not.toContain("/search");
    expect(out).toContain("<input");
  });

  it("still refuses scripts and handlers", () => {
    const out = sanitizeWebHtml(
      '<div><script>alert(1)</script><button onclick="bad()">x</button></div>',
      "https://example.com/",
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("onclick");
  });

  it("scopes small inline CSS; fetch drops huge sheets, capture keeps them", async () => {
    const small = await isolateWebCss(
      `<style>body { background:#111 } header { color:#111 }</style><p>hi</p>`,
      "https://example.com/",
    );
    // `#111` rather than `#fff` on purpose: a blank root background is dropped
    // now so the pad's paper shows through — see webPagePaper.test.ts. What
    // this test is about is the scoping, which applies either way.
    expect(small).toMatch(/\.lc-web-doc\s*\{[^}]*background:#111/);
    expect(small).toMatch(/\.lc-web-doc header/);

    const huge = "body{color:red}".repeat(6_000);
    expect(huge.length).toBeGreaterThan(FETCH_STYLE_CAP);
    const before = styleTagStats(`<style>${huge}</style><p>hi</p>`);
    expect(before.max).toBeGreaterThan(FETCH_STYLE_CAP);

    const dropped = await isolateWebCss(
      `<style>${huge}</style><p>hi</p>`,
      "https://example.com/",
      "fetch",
    );
    expect(styleTagStats(dropped).max).toBe(0);
    expect(dropped).not.toMatch(/color:red/);
    expect(dropped).toMatch(/<p/);

    const kept = await isolateWebCss(
      `<style>${huge}</style><p>hi</p>`,
      "https://example.com/",
      "capture",
    );
    expect(styleTagStats(kept).max).toBeGreaterThan(FETCH_STYLE_CAP);
    expect(kept).toMatch(/color:red/);
    expect(kept).toMatch(/\.lc-web-doc/);
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

describe("linked stylesheets", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("fetches a linked sheet and scopes it, instead of dropping the design", async () => {
    /*
     * Wikipedia keeps almost none of its appearance in inline <style>. Dropping
     * the links — the old safe answer — is what left raw HTML on the page.
     */
    globalThis.fetch = (async () =>
      new Response("body { background: #fff } .mw-body { max-width: 60em }", {
        status: 200,
      })) as typeof fetch;
    const html = await isolateWebCss(
      '<link rel="stylesheet" href="/w/load.php?m=site"><p>Hello</p>',
      "https://en.wikipedia.org/wiki/Thing",
      "fetch",
    );
    expect(html).not.toContain("<link");
    expect(html).toContain("Hello");
    // Scoped, so the sheet cannot repaint the app's own header.
    expect(html).toContain(".lc-web-doc");
    expect(html).toMatch(/max-width:\s*60em/);
  });

  it("drops a sheet that will not load and keeps the page", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 404 })) as typeof fetch;
    const html = await isolateWebCss(
      '<link rel="stylesheet" href="https://example.com/a.css"><p>Hello</p>',
      "https://example.com/",
      "fetch",
    );
    expect(html).not.toContain("<link");
    expect(html).toContain("Hello");
  });

  it("never leaves a link behind for the app to be styled by", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const html = await isolateWebCss(
      '<link rel="stylesheet" href="https://example.com/a.css"><p>Hi</p>',
      "https://example.com/",
      "fetch",
    );
    expect(html).not.toContain("<link");
  });
});

describe("readerPageFromHtml", () => {
  const wikiUrl = "https://en.wikipedia.org/wiki/Single_source_of_truth";
  const body = `
    <p>In information systems design and theory, single source of truth is the
    practice of structuring information models and associated data schemata such
    that every data element is mastered in exactly one place. Any possible
    linkages to this data element are by reference only.</p>
    <p>Because all other locations of the data just refer back to the primary
    location, updates to the data element in the primary location propagate to
    the entire system without the possibility of a duplicate value somewhere
    being forgotten. Deployment of an SSOT architecture is becoming increasingly
    important in enterprise settings.</p>
    <p>The master data is never copied and revised only references to it are made.
    This means that all reads and updates go directly to the SSOT, and the master
    data is copied but the copies are only read-only in nature.</p>
  `;

  it("takes the reader path for Wikipedia-shaped HTML without a capture webview", async () => {
    const html = `<!doctype html><html><head><title>Single source of truth - Wikipedia</title></head>
      <body><nav><a href="/wiki/Main_Page">Main page</a></nav>
      <main><article><h1>Single source of truth</h1>${body}</article></main></body></html>`;
    const page = await readerPageFromHtml(html, wikiUrl);
    expect(page).not.toBeNull();
    expect(page!.source).toBe("reader");
    expect(page!.html).toContain("mastered in exactly one place");
    expect(page!.html).not.toContain("Main page");
  });

  it("declines a nav page so capture can still run", async () => {
    const html = `<!doctype html><html><body>
      <a href="/a">one</a><a href="/b">two</a><a href="/c">three</a>
    </body></html>`;
    expect(await readerPageFromHtml(html, "https://www.google.com/")).toBeNull();
  });
});
