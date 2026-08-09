/** @vitest-environment jsdom */

/**
 * Anchors are the part of a footnote that has to survive being closed, so the
 * round trip — range → offsets → range → the same words — is what these prove.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  anchorFromRange,
  normalizeAnchor,
  regionAnchorFromRect,
  scopeOfNode,
  scopeRootIn,
  scopeRootsIn,
  excerptOf,
  rangeFromAnchor,
  snapToWords,
  textForAnchor,
  textNodesOf,
  textOf,
} from "./docAnchors";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("textOf", () => {
  it("runs inline elements together, the way they read", () => {
    const root = mount("<p>Hash <em>maps</em> collide</p>");
    expect(textOf(root)).toBe("Hash maps collide");
  });

  it("breaks between blocks", () => {
    // Raw concatenation gives "CollisionsHash maps…", and a quote taken across
    // that seam is what gets asked about and searched for.
    const root = mount("<h1>Collisions</h1><p>Hash maps collide</p>");
    expect(textOf(root)).toBe("Collisions\nHash maps collide");
  });

  it("breaks between list items", () => {
    const root = mount("<ul><li>one</li><li>two</li></ul>");
    expect(textOf(root)).toBe("one\ntwo");
  });

  it("breaks between sibling roots — a PDF page, an EPUB chapter", () => {
    const root = mount(
      '<div class="page"><span>Hash maps collide</span></div>' +
        '<div class="page"><span>Open addressing</span></div>',
    );
    expect(textOf(root)).toBe("Hash maps collide\nOpen addressing");
  });

  it("finds every text node under nesting", () => {
    const root = mount("<ul><li>a<span>b<b>c</b></span></li></ul>");
    expect(textNodesOf(root).map((node) => node.data)).toEqual(["a", "b", "c"]);
  });
});

describe("quotes across a block boundary", () => {
  it("keeps the break in the quoted text", () => {
    const root = mount("<h1>Collisions</h1><p>Hash maps collide</p>");
    expect(textForAnchor(root, { kind: "text", start: 0, end: 15 })).toBe("Collisions\nHash");
  });

  it("resolves to a range that spans both blocks", () => {
    const root = mount("<h1>Collisions</h1><p>Hash maps collide</p>");
    const range = rangeFromAnchor(root, { kind: "text", start: 0, end: 15 });
    expect(range).not.toBeNull();
    expect(range!.startContainer.textContent).toBe("Collisions");
    expect(range!.endContainer.textContent).toBe("Hash maps collide");
  });

  it("rolls an end that lands on the separator back to real text", () => {
    const root = mount("<h1>Collisions</h1><p>Hash maps collide</p>");
    // Offset 10 is the newline itself; the quote is still "Collisions".
    expect(textForAnchor(root, { kind: "text", start: 0, end: 10 })).toBe("Collisions");
  });

  it("snaps words without crossing the break", () => {
    const text = textOf(mount("<h1>Collisions</h1><p>Hash maps collide</p>"));
    expect(snapToWords(text, 2, 5)).toEqual([0, 10]);
  });
});

describe("anchor round trip", () => {
  it("names the same words after the range is thrown away", () => {
    const root = mount("<p>Hash <em>maps</em> collide</p>");
    const range = document.createRange();
    const [first] = textNodesOf(root);
    range.setStart(first, 0);
    range.setEnd(first, 4);
    const anchor = anchorFromRange(root, range);
    expect(anchor).toEqual({ kind: "text", start: 0, end: 4 });
    expect(textForAnchor(root, anchor!)).toBe("Hash");
  });

  it("spans element boundaries", () => {
    const root = mount("<p>Hash <em>maps</em> collide</p>");
    // "maps collide" starts inside <em> and ends in the sibling text node.
    expect(textForAnchor(root, { kind: "text", start: 5, end: 17 })).toBe("maps collide");
  });

  it("carries a scope through unchanged", () => {
    const root = mount("<p>page text</p>");
    const range = document.createRange();
    range.setStart(textNodesOf(root)[0], 0);
    range.setEnd(textNodesOf(root)[0], 4);
    expect(anchorFromRange(root, range, "page-3")?.scope).toBe("page-3");
  });

  it("refuses an empty range", () => {
    const root = mount("<p>text</p>");
    const range = document.createRange();
    range.setStart(textNodesOf(root)[0], 2);
    range.collapse(true);
    expect(anchorFromRange(root, range)).toBeNull();
  });

  it("returns null when the text has moved on under an old anchor", () => {
    const root = mount("<p>short</p>");
    expect(rangeFromAnchor(root, { kind: "text", start: 400, end: 420 })).toBeNull();
    expect(textForAnchor(root, { kind: "text", start: 400, end: 420 })).toBe("");
  });
});

describe("snapToWords", () => {
  const text = "Hash maps collide on equal keys";

  it("grows a mid-word hit out to whole words", () => {
    // A finger landing on "ashmap collisi" is a quote the coach answers
    // literally — snapping outward is the forgiving direction.
    expect(snapToWords(text, 6, 12)).toEqual([5, 17]);
    expect(text.slice(5, 17)).toBe("maps collide");
  });

  it("leaves a selection that is already on boundaries alone", () => {
    expect(snapToWords(text, 0, 4)).toEqual([0, 4]);
  });

  it("clamps past the end of the text", () => {
    const [, end] = snapToWords(text, 0, 999);
    expect(end).toBe(text.length);
  });

  it("expands a caret into the word under it", () => {
    expect(snapToWords(text, 7, 8)).toEqual([5, 9]);
  });
});

describe("excerptOf", () => {
  it("flattens whitespace", () => {
    expect(excerptOf("  two\n\n  lines  ")).toBe("two lines");
  });

  it("cuts long quotes with an ellipsis", () => {
    const long = "word ".repeat(60);
    const short = excerptOf(long, 20);
    expect(short).toHaveLength(20);
    expect(short.endsWith("…")).toBe(true);
  });
});


describe("scopes", () => {
  const paged = () =>
    mount(
      '<div data-doc-scope="p1"><p>Hash maps collide</p></div>' +
        '<div data-doc-scope="p2"><p>Open addressing</p></div>',
    );

  it("lists the scope roots in document order", () => {
    const body = paged();
    expect(scopeRootsIn(body).map((el) => el.dataset.docScope)).toEqual(["p1", "p2"]);
  });

  it("finds the root an anchor belongs to", () => {
    const body = paged();
    expect((scopeRootIn(body, "p2") as HTMLElement).textContent).toBe("Open addressing");
  });

  it("returns null for a page that has not rendered yet", () => {
    // A windowed document only has some pages in the DOM; a mark on a page that
    // is not there should fail to place quietly, not throw.
    expect(scopeRootIn(paged(), "p900")).toBeNull();
  });

  it("falls back to the body for an anchor with no scope", () => {
    const body = paged();
    expect(scopeRootIn(body, undefined)).toBe(body);
  });

  it("names the scope a node sits in", () => {
    const body = paged();
    const node = textNodesOf(body)[1];
    expect(scopeOfNode(body, node)).toBe("p2");
  });

  it("offsets are local to a scope, not to the whole document", () => {
    const body = paged();
    const page2 = scopeRootIn(body, "p2") as HTMLElement;
    // "Open" is at 0 in its own page even though it is far into the book.
    expect(textForAnchor(page2, { kind: "text", start: 0, end: 4, scope: "p2" })).toBe("Open");
  });
});

describe("normalizeAnchor", () => {
  it("tags an untagged legacy anchor as text", () => {
    expect(normalizeAnchor({ start: 1, end: 5 })).toEqual({ kind: "text", start: 1, end: 5 });
  });

  it("keeps a scope", () => {
    expect(normalizeAnchor({ start: 1, end: 5, scope: "p3" })?.scope).toBe("p3");
  });

  it("rejects a backwards range", () => {
    expect(normalizeAnchor({ start: 9, end: 2 })).toBeNull();
  });

  it("rejects a region with a non-numeric side", () => {
    expect(normalizeAnchor({ kind: "region", x: 0, y: 0, w: "10", h: 4 })).toBeNull();
  });

  it("rejects rubbish", () => {
    expect(normalizeAnchor(null)).toBeNull();
    expect(normalizeAnchor("nope")).toBeNull();
  });
});

describe("regionAnchorFromRect", () => {
  it("converts a viewport rect into the scope's own coordinates", () => {
    const body = mount('<div data-doc-scope="p1" style="width:200px;height:100px"></div>');
    const root = scopeRootIn(body, "p1") as HTMLElement;
    // jsdom reports zero-size boxes, so scale falls back to 1 and the maths is
    // a plain subtraction of the root's origin — which is what is being checked.
    const anchor = regionAnchorFromRect(root, { left: 12, top: 8, width: 40, height: 20 }, "p1");
    expect(anchor).toEqual({ kind: "region", x: 12, y: 8, w: 40, h: 20, scope: "p1" });
  });

  it("refuses a rectangle with no area", () => {
    const body = mount('<div data-doc-scope="p1"></div>');
    const root = scopeRootIn(body, "p1") as HTMLElement;
    expect(regionAnchorFromRect(root, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
  });
});

describe("snapToWords on whitespace", () => {
  /*
   * A fingertip is several characters wide and the gaps between words are a
   * real fraction of a line, so landing in one is not a rare case. The two
   * widening loops only grow outward from a word, so a caret in a gap had
   * nothing to grow from and the quote came back as the single space touched.
   */
  it("picks the following word when the hold lands on a space", () => {
    const text = "alpha beta gamma";
    const [start, end] = snapToWords(text, 5, 5);
    expect(text.slice(start, end)).toBe("beta");
  });

  it("picks a word across a run of spaces", () => {
    const text = "alpha     beta";
    const [start, end] = snapToWords(text, 7, 7);
    expect(text.slice(start, end)).toBe("beta");
  });

  it("falls back to the previous word at the end of the text", () => {
    // Nothing ahead to reach for — the word behind the finger is the only
    // honest answer, and is better than an empty quote.
    const text = "alpha beta ";
    const [start, end] = snapToWords(text, 11, 11);
    expect(text.slice(start, end)).toBe("beta");
  });

  it("picks a word across a block separator", () => {
    const text = "heading\n\nbody text";
    const [start, end] = snapToWords(text, 7, 7);
    expect(text.slice(start, end)).toBe("body");
  });

  it("still snaps a mid-word hit outward, unchanged", () => {
    const text = "collision resolution";
    const [start, end] = snapToWords(text, 3, 6);
    expect(text.slice(start, end)).toBe("collision");
  });

  it("leaves a selection that already spans words alone", () => {
    const text = "alpha beta gamma";
    const [start, end] = snapToWords(text, 0, 10);
    expect(text.slice(start, end)).toBe("alpha beta");
  });

  it("does not hang on text that is nothing but spaces", () => {
    const [start, end] = snapToWords("     ", 2, 2);
    expect(end).toBeGreaterThanOrEqual(start);
  });

  it("does not hang on empty text", () => {
    expect(snapToWords("", 0, 0)).toEqual([0, 0]);
  });
});
