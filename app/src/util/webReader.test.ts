/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { extractDocumentPages } from "./docExtract";
import { MAX_LINK_DENSITY, MIN_ARTICLE_CHARS, extractArticle, linkDensity } from "./webReader";

const URL_UNDER_TEST = "https://en.wikipedia.org/wiki/Single_source_of_truth";

/** Enough prose that Readability sees an article rather than a stub. */
const BODY = `
  <p>In information systems design and theory, single source of truth is the
  practice of structuring information models and associated data schemata such
  that every data element is mastered in exactly one place. Any possible
  linkages to this data element are by reference only.</p>
  <p>Because all other locations of the data just refer back to the primary
  location, updates to the data element in the primary location propagate to the
  entire system without the possibility of a duplicate value somewhere being
  forgotten. Deployment of an SSOT architecture is becoming increasingly
  important in enterprise settings.</p>
  <p>The master data is never copied and revised only references to it are made.
  This means that all reads and updates go directly to the SSOT, and the master
  data is copied but the copies are only read-only in nature.</p>
`;

/** The page around the article: the part nobody wants marked up or indexed. */
const FURNITURE = `
  <nav id="mw-panel">
    <ul>
      <li><a href="/wiki/Main_Page">Main page</a></li>
      <li><a href="/wiki/Special:Contents">Contents</a></li>
      <li><a href="/wiki/Help:Introduction">Learn to edit</a></li>
      <li><a href="/wiki/Special:Upload">Upload file</a></li>
      <li><a href="/wiki/Special:SpecialPages">Special pages</a></li>
    </ul>
  </nav>
  <footer id="footer">
    <ul>
      <li><a href="/wiki/Cookie_statement">Cookie statement</a></li>
      <li><a href="/wiki/Mobile_view">Mobile view</a></li>
      <li>Deutsch</li><li>Magyar</li><li>日本語</li><li>Norsk bokmål</li>
    </ul>
  </footer>
`;

function wikipediaish(): string {
  return `<!doctype html><html><head><title>Single source of truth - Wikipedia</title></head>
    <body>${FURNITURE}
      <main><article><h1>Single source of truth</h1>${BODY}</article></main>
    ${FURNITURE}</body></html>`;
}

describe("extractArticle", () => {
  it("keeps the article and leaves the page around it behind", () => {
    const article = extractArticle(wikipediaish(), URL_UNDER_TEST);
    expect(article).not.toBeNull();
    expect(article!.html).toContain("mastered in exactly one place");
    for (const junk of ["Special pages", "Cookie statement", "Upload file", "Norsk bokmål"]) {
      expect(article!.html).not.toContain(junk);
    }
  });

  it("keeps inline figures, which is what the reader asked for", () => {
    const html = wikipediaish().replace(
      "<h1>Single source of truth</h1>",
      '<h1>Single source of truth</h1><figure><img src="/img/diagram.png" width="1200">' +
        "<figcaption>An SSOT schema</figcaption></figure>",
    );
    const article = extractArticle(html, URL_UNDER_TEST);
    expect(article!.html).toContain("<img");
    expect(article!.html).toContain("An SSOT schema");
  });

  it("strips the widths that would stop it reflowing", () => {
    /*
     * The capture happens at one window size and is read at another. Anything
     * carrying a number from the first is what stranded a snapshot in the corner
     * of a wider sheet.
     */
    const html = wikipediaish().replace(
      "<h1>Single source of truth</h1>",
      '<h1>Single source of truth</h1><img src="/img/a.png" width="1200" ' +
        'style="width:1200px;position:absolute">',
    );
    const article = extractArticle(html, URL_UNDER_TEST);
    expect(article!.html).not.toMatch(/width="1200"/);
    expect(article!.html).not.toMatch(/width:\s*1200px/);
    expect(article!.html).not.toMatch(/position:\s*absolute/);
  });

  it("resolves links against the page, not against us", () => {
    const article = extractArticle(
      `<!doctype html><html><body><article><h1>T</h1>${BODY}
        <p><a href="/wiki/Data_vault">data vault</a></p></article></body></html>`,
      URL_UNDER_TEST,
    );
    expect(article!.html).toContain("https://en.wikipedia.org/wiki/Data_vault");
  });

  it("declines a page that is not an article", () => {
    /*
     * A directory of links with no prose — a search result, a forum index. The
     * whole-page snapshot is the better answer for these, so declining is right.
     *
     * Length cannot tell these apart: sixty results are longer than a short
     * article. Link density can — prose has links in it, a directory is made of
     * them.
     */
    const links = Array.from(
      { length: 60 },
      (_, n) => `<li><a href="/r/${n}">Result number ${n}</a></li>`,
    ).join("");
    expect(extractArticle(`<!doctype html><html><body><ul>${links}</ul></body></html>`, "https://x.dev/"))
      .toBeNull();
  });

  it("declines a stub too short to be worth reading", () => {
    expect(
      extractArticle(
        "<!doctype html><html><body><article><p>Hello.</p></article></body></html>",
        "https://x.dev/",
      ),
    ).toBeNull();
    expect(MIN_ARTICLE_CHARS).toBeGreaterThan(100);
  });
});

describe("linkDensity", () => {
  const div = (html: string) => {
    const node = document.createElement("div");
    node.innerHTML = html;
    return node;
  };

  it("is low for prose with a link in it", () => {
    const node = div(
      "<p>The master data is never copied and revised, only " +
        '<a href="/x">references</a> to it are made, which keeps one place true.</p>',
    );
    expect(linkDensity(node)).toBeLessThan(MAX_LINK_DENSITY);
  });

  it("is high for a list made of links", () => {
    const node = div("<ul><li><a href=/a>Main page</a></li><li><a href=/b>Upload file</a></li></ul>");
    expect(linkDensity(node)).toBeGreaterThan(MAX_LINK_DENSITY);
  });

  it("calls an empty element all links rather than dividing by zero", () => {
    expect(linkDensity(div(""))).toBe(1);
  });
});

describe("what reaches the index", () => {
  it("indexes the article, not the navigation", async () => {
    /*
     * The reason for all of this. `extractDocumentPages` runs `htmlToText` over
     * whatever the document holds, so a whole-page snapshot fed the room "Learn
     * to edit", "Upload file", "Special pages" and every language name. Once the
     * document *is* the article there is nothing to filter.
     */
    const raw = await extractDocumentPages({
      docType: "web",
      name: URL_UNDER_TEST,
      text: wikipediaish(),
    });
    expect(raw[0]!.text).toContain("Special pages");

    const article = extractArticle(wikipediaish(), URL_UNDER_TEST);
    const clean = await extractDocumentPages({
      docType: "web",
      name: URL_UNDER_TEST,
      text: article!.html,
    });
    expect(clean[0]!.text).toContain("mastered in exactly one place");
    for (const junk of ["Special pages", "Cookie statement", "Upload file"]) {
      expect(clean[0]!.text).not.toContain(junk);
    }
  });
});
