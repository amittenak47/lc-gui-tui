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
    expect(out.html).toMatch(/src="data:image\/gif;base64,/);
    expect(out.html).not.toMatch(/href="\/x\.css"/);
  });
});
