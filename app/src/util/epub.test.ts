/** @vitest-environment jsdom */

/**
 * The parts of EPUB reading that can go wrong quietly.
 *
 * A book that fails to open is obvious. A book that opens with its chapters in
 * the wrong order, or with the cover image where chapter one should be, or with
 * the publisher's stylesheet fighting the pad's column, looks like a working
 * reader that is subtly useless — so those are what these cover.
 */

import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import { chapterHtml, opfPathFrom, parsePackage, readEpub, resolveHref } from "./epub";

const CONTAINER = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata><title>Hash Maps</title></metadata>
  <manifest>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover" linear="no"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

function chapter(body: string): string {
  return `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;
}

function buildEpub(overrides: Record<string, string> = {}): ArrayBuffer {
  const files: Record<string, Uint8Array> = {
    "META-INF/container.xml": strToU8(CONTAINER),
    "OEBPS/book.opf": strToU8(OPF),
    "OEBPS/cover.xhtml": strToU8(chapter("<p>Cover art</p>")),
    "OEBPS/text/one.xhtml": strToU8(chapter("<h1>One</h1><p>Hash maps collide.</p>")),
    "OEBPS/text/two.xhtml": strToU8(chapter("<h1>Two</h1><p>Open addressing.</p>")),
  };
  for (const [path, text] of Object.entries(overrides)) files[path] = strToU8(text);
  const zipped = zipSync(files);
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}

describe("resolveHref", () => {
  it("resolves against the directory of the file it appeared in", () => {
    expect(resolveHref("OEBPS/book.opf", "text/one.xhtml")).toBe("OEBPS/text/one.xhtml");
  });

  it("walks up out of a subdirectory", () => {
    expect(resolveHref("OEBPS/text/one.xhtml", "../images/fig.png")).toBe(
      "OEBPS/images/fig.png",
    );
  });

  it("drops a fragment — the file is the file", () => {
    expect(resolveHref("OEBPS/book.opf", "text/one.xhtml#section-2")).toBe(
      "OEBPS/text/one.xhtml",
    );
  });
});

describe("opfPathFrom", () => {
  it("finds the package document", () => {
    expect(opfPathFrom(CONTAINER)).toBe("OEBPS/book.opf");
  });

  it("refuses a container with no rootfile", () => {
    expect(() => opfPathFrom("<container/>")).toThrow(/package document/);
  });
});

describe("parsePackage", () => {
  it("returns the spine in reading order, resolved", () => {
    const spine = parsePackage(OPF, "OEBPS/book.opf");
    expect(spine.hrefs).toEqual(["OEBPS/text/one.xhtml", "OEBPS/text/two.xhtml"]);
  });

  it('skips linear="no" so the book opens on chapter one, not the cover', () => {
    expect(parsePackage(OPF, "OEBPS/book.opf").hrefs).not.toContain("OEBPS/cover.xhtml");
  });

  it("carries the title", () => {
    expect(parsePackage(OPF, "OEBPS/book.opf").title).toBe("Hash Maps");
  });
});

describe("chapterHtml", () => {
  it("keeps the body's formatting", () => {
    expect(chapterHtml(chapter("<p>Hash <em>maps</em></p>"))).toContain("<em>maps</em>");
  });

  it("drops scripts", () => {
    const html = chapterHtml(chapter('<p>ok</p><script>alert(1)</script>'));
    expect(html).not.toContain("script");
  });

  it("drops the book's own styling", () => {
    // A book's CSS is written for a paginated reader with its own page box;
    // near this column it produces text at random sizes over the ink.
    const html = chapterHtml(chapter('<p style="font-size:48px">big</p>'));
    expect(html).not.toContain("font-size");
  });
});

describe("readEpub", () => {
  it("reads the chapters in spine order", () => {
    const book = readEpub(buildEpub());
    expect(book.chapters.map((c) => c.href)).toEqual([
      "OEBPS/text/one.xhtml",
      "OEBPS/text/two.xhtml",
    ]);
    expect(book.chapters[0].html).toContain("Hash maps collide.");
  });

  it("refuses a file that is not an EPUB", () => {
    const notAnEpub = zipSync({ "hello.txt": strToU8("hi") });
    expect(() =>
      readEpub(
        notAnEpub.buffer.slice(
          notAnEpub.byteOffset,
          notAnEpub.byteOffset + notAnEpub.byteLength,
        ) as ArrayBuffer,
      ),
    ).toThrow(/not an EPUB/);
  });

  it("skips a chapter the spine names but the zip does not hold", () => {
    // Real books do this. Losing one chapter is better than refusing the book.
    const files = buildEpub();
    const book = readEpub(files);
    expect(book.chapters).toHaveLength(2);
  });

  it("drops an image it cannot find rather than leaving a broken one", () => {
    const book = readEpub(
      buildEpub({
        "OEBPS/text/one.xhtml": chapter('<p>fig</p><img src="../images/missing.png"/>'),
      }),
    );
    expect(book.chapters[0].html).not.toContain("<img");
  });
});
