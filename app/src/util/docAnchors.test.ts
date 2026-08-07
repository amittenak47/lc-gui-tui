/** @vitest-environment jsdom */

/**
 * Anchors are the part of a footnote that has to survive being closed, so the
 * round trip — range → offsets → range → the same words — is what these prove.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  anchorFromRange,
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
  it("concatenates text nodes in reading order, across elements", () => {
    const root = mount("<p>Hash <em>maps</em></p><p> collide</p>");
    expect(textOf(root)).toBe("Hash maps collide");
  });

  it("finds every text node under nesting", () => {
    const root = mount("<ul><li>a<span>b<b>c</b></span></li></ul>");
    expect(textNodesOf(root).map((node) => node.data)).toEqual(["a", "b", "c"]);
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
    expect(anchor).toEqual({ start: 0, end: 4 });
    expect(textForAnchor(root, anchor!)).toBe("Hash");
  });

  it("spans element boundaries", () => {
    const root = mount("<p>Hash <em>maps</em> collide</p>");
    // "maps collide" starts inside <em> and ends in the sibling text node.
    expect(textForAnchor(root, { start: 5, end: 17 })).toBe("maps collide");
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
    expect(rangeFromAnchor(root, { start: 400, end: 420 })).toBeNull();
    expect(textForAnchor(root, { start: 400, end: 420 })).toBe("");
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
