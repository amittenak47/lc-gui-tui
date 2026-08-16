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
