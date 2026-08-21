import { describe, expect, it } from "vitest";

import { extractDocumentPages } from "./docExtract";

describe("extraction progress", () => {
  it("reports a single step for a page indexed from its marks", async () => {
    const seen: Array<[number, number]> = [];
    await extractDocumentPages({
      docType: "web",
      name: "https://example.com",
      text: "<p>The article.</p>",
      marks: [{ excerpt: "The article." }],
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.at(-1)).toEqual([1, 1]);
  });

  it("reports a single step for markdown", async () => {
    const seen: Array<[number, number]> = [];
    await extractDocumentPages({
      docType: "markdown",
      name: "n.md",
      text: "# Title",
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.at(-1)).toEqual([1, 1]);
  });

  it("says nothing about a document with no text to read", async () => {
    // Nothing was extracted, so there is no progress to claim.
    const seen: Array<[number, number]> = [];
    await extractDocumentPages({
      docType: "markdown",
      name: "n.md",
      text: "   ",
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([]);
  });

  it("is optional, and its absence changes nothing", async () => {
    const pages = await extractDocumentPages({
      docType: "markdown",
      name: "n.md",
      text: "# Title",
    });
    expect(pages).toHaveLength(1);
  });
});
