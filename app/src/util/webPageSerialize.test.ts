/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { serializeCurrentDocument } from "./webPageSerialize";

const TINY_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (ch) => ch.charCodeAt(0),
);

describe("serializeCurrentDocument", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("inlines same-origin CSS and images and drops scripts", async () => {
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/x.css")) {
          return new Response("p{color:red}", {
            headers: { "content-type": "text/css" },
          });
        }
        if (url.endsWith("/x.gif")) {
          return new Response(TINY_GIF, {
            headers: { "content-type": "image/gif" },
          });
        }
        return new Response("missing", { status: 404 });
      },
    );

    document.documentElement.innerHTML = `
      <head>
        <link rel="stylesheet" href="/x.css" />
        <link rel="preload" href="/skip.js" as="script" />
        <link rel="modulepreload" href="/interactivity/index.min.js" />
        <script>window.__evil = 1</script>
      </head>
      <body>
        <p>hi</p>
        <img src="/x.gif" alt="" />
        <iframe src="/frame"></iframe>
      </body>
    `;

    const out = await serializeCurrentDocument();
    expect(out.html).toMatch(/p\{color:red\}/);
    expect(out.html).not.toMatch(/<script/i);
    expect(out.html).not.toMatch(/<iframe/i);
    expect(out.html).not.toMatch(/rel="preload"/i);
    expect(out.html).not.toMatch(/modulepreload/i);
    expect(out.html).not.toMatch(/index\.min\.js/);
    expect(out.html).toMatch(/src="data:image\/gif;base64,/);
    expect(out.html).not.toMatch(/href="\/x\.css"/);
  });

  it("makes the inlined image the only candidate", async () => {
    /*
     * `srcset` outranks `src` whenever it is present, and `<picture><source>`
     * wins before the `<img>` is consulted at all. Leaving either in place sent
     * the frozen page back to the CDN for a picture it was already carrying —
     * and a broken-image glyph is what came back.
     */
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/x.gif")) {
        return new Response(TINY_GIF, { headers: { "content-type": "image/gif" } });
      }
      return new Response("missing", { status: 404 });
    });

    document.documentElement.innerHTML = `
      <body>
        <picture>
          <source srcset="https://cdn.example.com/a.webp" type="image/webp" />
          <img src="/x.gif" srcset="https://cdn.example.com/a.gif 2x" sizes="50vw" alt="" />
        </picture>
        <p>hi</p>
      </body>
    `;

    const out = await serializeCurrentDocument();
    expect(out.html).toMatch(/src="data:image\/gif;base64,/);
    expect(out.html).not.toMatch(/srcset/i);
    expect(out.html).not.toMatch(/cdn\.example\.com/);
    expect(out.html).not.toMatch(/<source/i);
  });

  it("marks what is invisible and where the pinned chrome sits", async () => {
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    document.documentElement.innerHTML = `
      <body>
        <span aria-hidden="true" id="icon">*</span>
        <div id="gone" style="display:none">junk</div>
        <p>hi</p>
      </body>
    `;
    const out = await serializeCurrentDocument();
    // The icon is aria-hidden and visible — the case the attribute rule broke.
    expect(out.html).toMatch(/id="icon"(?![^>]*data-lc-hidden)/);
    expect(out.html).toMatch(/id="gone"[^>]*data-lc-hidden/);
  });

  it("prefers CSSOM text over re-fetching stylesheets", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(".css")) {
        throw new Error("stylesheet fetch should not run when cssRules is readable");
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    document.documentElement.innerHTML = `
      <head><style>p{color:blue}</style></head>
      <body><p>hi</p></body>
    `;

    const out = await serializeCurrentDocument();
    expect(out.html).toMatch(/p\s*\{[^}]*color:\s*blue/);
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes(".css")),
    ).toHaveLength(0);
  });
});

describe("shadow DOM", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("lifts an open shadow root into the serialised HTML", async () => {
    /*
     * The payload is `documentElement.outerHTML`, and `outerHTML` does not
     * descend into a shadow root — so a page built from web components came out
     * with every custom element empty. Not mangled: absent. This is the guard
     * for that, and it fails without the flatten pass.
     */
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).innerHTML =
      "<p>inside the shadow</p><style>p { color: rebeccapurple }</style>";
    document.body.append(host);

    const { html } = await serializeCurrentDocument();
    expect(html).toContain("inside the shadow");
    expect(html).toContain("rebeccapurple");
  });

  it("lifts roots nested inside roots, deepest first", async () => {
    const outer = document.createElement("div");
    const outerRoot = outer.attachShadow({ mode: "open" });
    const inner = document.createElement("div");
    inner.attachShadow({ mode: "open" }).innerHTML = "<span>two levels down</span>";
    outerRoot.append(inner);
    document.body.append(outer);

    const { html } = await serializeCurrentDocument();
    expect(html).toContain("two levels down");
  });

  it("keeps slotted light-DOM children and drops the slot itself", async () => {
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).innerHTML = "<slot><em>fallback text</em></slot>";
    document.body.append(host);

    const { html } = await serializeCurrentDocument();
    expect(html).toContain("fallback text");
    expect(html).not.toContain("<slot");
  });

  it("leaves a closed root alone rather than throwing", async () => {
    // Page script cannot reach a closed root, so it stays invisible. The only
    // requirement is that meeting one does not break the whole capture.
    const host = document.createElement("div");
    host.attachShadow({ mode: "closed" }).innerHTML = "<p>unreachable</p>";
    document.body.append(host);
    host.append(document.createTextNode("light dom survives"));

    const { html } = await serializeCurrentDocument();
    expect(html).toContain("light dom survives");
  });
});

describe("constructable stylesheets", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("captures adoptedStyleSheets, which document.styleSheets leaves out", async () => {
    /*
     * `document.styleSheets` is a different list from `adoptedStyleSheets`, so
     * a framework that builds its CSS at runtime had all of it dropped without
     * a word. Skipped where the DOM implementation has no constructable sheets.
     */
    if (typeof CSSStyleSheet === "undefined" || !("replaceSync" in CSSStyleSheet.prototype)) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".adopted { color: seagreen }");
    (document as unknown as { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets = [sheet];

    const { html } = await serializeCurrentDocument();
    expect(html).toContain("seagreen");
  });
});
