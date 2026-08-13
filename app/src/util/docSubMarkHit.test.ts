/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

import { caretPointIn, charOffsetInNode } from "./docSubMarkHit";

/*
 * jsdom has no layout, so every range answers a zero rectangle. The stub below
 * is a monospace page: one text node per line, 10px per character, lines 20px
 * apart. That is enough geometry for the only question these helpers ask —
 * which character is under a point — and it makes the failure the old sampler
 * had (landing ~17 characters away in a long node) directly assertable.
 */
const CHAR_W = 10;
const LINE_H = 16;
const LINE_GAP = 20;
const FIRST_LINE_TOP = 100;

function box(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  } as DOMRect;
}

const realBoundingRect = Range.prototype.getBoundingClientRect;
const realClientRects = Range.prototype.getClientRects;

/** Lay the given text nodes out, one per line, and stub Range geometry. */
function layout(nodes: Text[]): void {
  const lineOf = new Map<Text, number>();
  nodes.forEach((node, index) => lineOf.set(node, index));
  const rectFor = (range: Range): DOMRect => {
    const node = range.startContainer as Text;
    const line = lineOf.get(node);
    if (line == null) return box(0, 0, 0, 0);
    const from = range.startOffset;
    const to = range.endContainer === node ? range.endOffset : node.data.length;
    return box(
      from * CHAR_W,
      FIRST_LINE_TOP + line * LINE_GAP,
      Math.max(0, (to - from) * CHAR_W),
      LINE_H,
    );
  };
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(this: Range) {
    return rectFor(this);
  };
  Range.prototype.getClientRects = function getClientRects(this: Range) {
    const rect = rectFor(this);
    return [rect] as unknown as DOMRectList;
  };
}

/** Body whose layout scale is 1, for the band conversion. */
function bodyAt(left: number, top: number): HTMLElement {
  const body = document.createElement("div");
  Object.defineProperty(body, "offsetWidth", { value: 400 });
  body.getBoundingClientRect = () => box(left, top, 400, 400);
  return body;
}

function lineTop(line: number): number {
  return FIRST_LINE_TOP + line * LINE_GAP + LINE_H / 2;
}

afterEach(() => {
  Range.prototype.getBoundingClientRect = realBoundingRect;
  Range.prototype.getClientRects = realClientRects;
});

describe("charOffsetInNode", () => {
  it("lands inside the touched word of a long node", () => {
    // "alpha beta gamma delta …" repeated past 400 characters — the size of a
    // real markdown paragraph, where the old length/24 sampler stepped 17.
    const prose = "alpha beta gamma delta epsilon zeta eta theta ".repeat(10);
    const node = document.createTextNode(prose);
    document.body.appendChild(node);
    layout([node]);

    // Character 20 spans x=200..210; aim just left of its midpoint.
    const offset = charOffsetInNode(node, 203, lineTop(0));
    expect(offset).toBe(20);
    // The word under that character is the one that gets underlined.
    const wordStart = prose.lastIndexOf(" ", offset - 1) + 1;
    const wordEnd = prose.indexOf(" ", offset);
    expect(offset).toBeGreaterThanOrEqual(wordStart);
    expect(offset).toBeLessThan(wordEnd);
  });

  it("clamps past the end of the text", () => {
    const node = document.createTextNode("short line");
    document.body.appendChild(node);
    layout([node]);

    expect(charOffsetInNode(node, 9_000, lineTop(0))).toBe("short line".length);
    expect(charOffsetInNode(node, -50, lineTop(0))).toBe(0);
  });
});

describe("caretPointIn", () => {
  it("skips whitespace-only nodes", () => {
    const root = document.createElement("div");
    const blank = document.createTextNode("   ");
    const prose = document.createTextNode("hash map collisions");
    root.append(blank, prose);
    document.body.appendChild(root);
    layout([blank, prose]);

    const hit = caretPointIn(root, 53, lineTop(1), { skipNative: true });
    expect(hit?.node).toBe(prose);
    expect(hit?.offset).toBe(5);
  });

  it("prefers text inside the mark bands", () => {
    const root = document.createElement("div");
    const above = document.createTextNode("first paragraph text");
    const inside = document.createTextNode("second paragraph text");
    root.append(above, inside);
    document.body.appendChild(root);
    layout([above, inside]);

    const body = bodyAt(0, 0);
    // Band covers line 1 only; the pointer sits below both lines.
    const bands = [
      { left: 0, top: FIRST_LINE_TOP + LINE_GAP, width: 300, height: LINE_H },
    ];

    const onBand = caretPointIn(root, 70, lineTop(1), { skipNative: true, bands, body });
    expect(onBand?.node).toBe(inside);
    expect(onBand?.offset).toBe(7);

    // Dragging below the mark stays on the banded line and runs to its end,
    // rather than jumping back to the paragraph above.
    const below = caretPointIn(root, 70, 400, { skipNative: true, bands, body });
    expect(below?.node).toBe(inside);
    expect(below?.offset).toBe(inside.data.length);
  });

  it("still answers outside the bands rather than freezing the drag", () => {
    const root = document.createElement("div");
    const only = document.createTextNode("one line of prose");
    root.append(only);
    document.body.appendChild(root);
    layout([only]);

    const body = bodyAt(0, 0);
    // A band nothing intersects — the drag left the mark.
    const bands = [{ left: 0, top: 900, width: 100, height: 10 }];

    const hit = caretPointIn(root, 43, lineTop(0), { skipNative: true, bands, body });
    expect(hit?.node).toBe(only);
    expect(hit?.offset).toBe(4);
  });
});
