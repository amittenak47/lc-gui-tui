/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest";

import { anchorFromRange, isTextAnchor, normalizeAnchor, rangeFromAnchor } from "./docAnchors";

function docWith(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function selectWords(root: HTMLElement, phrase: string): Range {
  const text = root.querySelector("p")!.firstChild as Text;
  const at = text.data.indexOf(phrase);
  const range = document.createRange();
  range.setStart(text, at);
  range.setEnd(text, at + phrase.length);
  return range;
}

describe("a mark whose page was captured again", () => {
  it("re-finds its words when the offsets have moved", () => {
    /*
     * The hole §1d opened: a web pad's identity is its address, so a second
     * capture replaces the page under the same hash and every offset points
     * into a string that is gone. Before this, the mark kept displaying its
     * excerpt and silently pointed at whatever now sat at those positions.
     */
    const first = docWith("<p>before the marked words after</p>");
    const anchor = anchorFromRange(first, selectWords(first, "marked words"))!;
    expect(isTextAnchor(anchor) && anchor.exact).toBe("marked words");

    const second = docWith("<p>a new banner was added here, before the marked words after</p>");
    const range = rangeFromAnchor(second, anchor)!;
    expect(range.toString()).toBe("marked words");
  });

  it("still uses the offsets when nothing moved", () => {
    const root = docWith("<p>before the marked words after</p>");
    const anchor = anchorFromRange(root, selectWords(root, "marked words"))!;
    expect(rangeFromAnchor(root, anchor)!.toString()).toBe("marked words");
  });

  it("finds nothing when the words are genuinely gone", () => {
    // Tomorrow's feed. This must not resolve to something else that happens to
    // sit at those character positions.
    const first = docWith("<p>before the marked words after</p>");
    const anchor = anchorFromRange(first, selectWords(first, "marked words"))!;
    const other = docWith("<p>an entirely different page with other content here</p>");
    expect(rangeFromAnchor(other, anchor)).toBeNull();
  });

  it("resolves an old anchor with no quote exactly as before", () => {
    // Everything written before this existed. The offset path is untouched.
    const root = docWith("<p>before the marked words after</p>");
    const old = normalizeAnchor({ kind: "text", start: 11, end: 23 })!;
    expect(isTextAnchor(old) && old.exact).toBeUndefined();
    expect(rangeFromAnchor(root, old)!.toString()).toBe("marked words");
  });

  it("survives a round trip through storage", () => {
    const root = docWith("<p>before the marked words after</p>");
    const anchor = anchorFromRange(root, selectWords(root, "marked words"))!;
    const back = normalizeAnchor(JSON.parse(JSON.stringify(anchor)))!;
    expect(back).toEqual(anchor);
  });

  it("picks the occurrence its surroundings identify", () => {
    const first = docWith("<p>alpha Sign in beta and gamma Sign in delta</p>");
    const text = first.querySelector("p")!.firstChild as Text;
    const at = text.data.lastIndexOf("Sign in");
    const range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at + "Sign in".length);
    const anchor = anchorFromRange(first, range)!;

    // Re-captured with something prepended, so every offset is wrong.
    const second = docWith("<p>NEW alpha Sign in beta and gamma Sign in delta</p>");
    const found = rangeFromAnchor(second, anchor)!;
    const stream = second.textContent!;
    expect(found.startOffset).toBe(stream.lastIndexOf("Sign in"));
  });
});
