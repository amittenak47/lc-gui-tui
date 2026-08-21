import { describe, expect, it } from "vitest";

import { MARK_GROUP_CHARS, webPagesFromMarks } from "./webMarkPages";

const mark = (excerpt: string) => ({ excerpt });

describe("webPagesFromMarks", () => {
  it("puts a handful of short marks in one chunk, not one each", () => {
    /*
     * The reason this function exists. One entry per mark would make a hundred
     * marks a hundred chunks, and retrieval takes four of them capped at 4000
     * characters — four tiny chunks would spend four slots on a few dozen words.
     */
    const pages = webPagesFromMarks([mark("first note"), mark("second"), mark("third")]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.text).toBe("first note\n\nsecond\n\nthird");
  });

  it("splits once a chunk is full", () => {
    const long = "x".repeat(MARK_GROUP_CHARS - 100);
    const pages = webPagesFromMarks([mark(long), mark("y".repeat(500))]);
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it("lets an over-long mark stand alone rather than cutting it", () => {
    // Splitting an excerpt splits its meaning.
    const huge = "z".repeat(MARK_GROUP_CHARS * 2);
    const pages = webPagesFromMarks([mark(huge)]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.text).toHaveLength(huge.length);
  });

  it("keeps the order marks were made in", () => {
    const pages = webPagesFromMarks([mark("alpha"), mark("beta")]);
    expect(pages[0]!.text.indexOf("alpha")).toBeLessThan(pages[0]!.text.indexOf("beta"));
  });

  it("drops empty and whitespace-only marks", () => {
    const pages = webPagesFromMarks([mark("   "), mark(""), mark("real")]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.text).toBe("real");
  });

  it("collapses the whitespace a selection drags in", () => {
    const pages = webPagesFromMarks([mark("a  \n\t b")]);
    expect(pages[0]!.text).toBe("a b");
  });

  it("has nothing to say about a page with no marks", () => {
    // The caller falls back to the whole page here — see `extractDocumentPages`.
    expect(webPagesFromMarks([])).toEqual([]);
  });
});

describe("extractDocumentPages for a web page", () => {
  it("indexes the marks when there are any, and the page when there are not", async () => {
    const { extractDocumentPages } = await import("./docExtract");
    const html = "<html><body><nav>Home About Store</nav><p>The article itself.</p></body></html>";

    const marked = await extractDocumentPages({
      docType: "web",
      name: "https://example.com",
      text: html,
      marks: [{ excerpt: "The article itself." }],
    });
    expect(marked).toHaveLength(1);
    // The nav is the thing this keeps out.
    expect(marked[0]!.text).toBe("The article itself.");
    expect(marked[0]!.text).not.toContain("About");

    const unmarked = await extractDocumentPages({
      docType: "web",
      name: "https://example.com",
      text: html,
    });
    expect(unmarked[0]!.text).toContain("About");
  });

  it("leaves every other kind of document whole", async () => {
    const { extractDocumentPages } = await import("./docExtract");
    // Opening a file *was* the decision, so marks do not narrow it.
    const pages = await extractDocumentPages({
      docType: "markdown",
      name: "n.md",
      text: "# Title\n\nAll of the note.",
      marks: [{ excerpt: "All" }],
    });
    expect(pages[0]!.text).toContain("All of the note.");
  });
});
