/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

import { charIndexAtPoint, charOffsetAtPoint } from "./docSubMarkHit";

const CHAR_W = 8;
const LINE_H = 16;

function mockRangeGeometry() {
  const proto = Range.prototype;
  const boxOf = (range: Range): DOMRect => {
    const node = range.startContainer;
    if (!node) {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
        toJSON() {},
      } as DOMRect;
    }
    if (node.nodeType !== Node.TEXT_NODE) {
      const el = node as HTMLElement;
      const text = el.textContent ?? "";
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: text.length * CHAR_W,
        height: LINE_H,
        right: text.length * CHAR_W,
        bottom: LINE_H,
        toJSON() {},
      } as DOMRect;
    }
    const start = range.startOffset;
    const end = range.collapsed ? start : range.endOffset;
    const left = start * CHAR_W;
    const width = Math.max(range.collapsed ? 0 : (end - start) * CHAR_W, 0);
    return {
      x: left,
      y: 0,
      left,
      top: 0,
      width,
      height: LINE_H,
      right: left + (range.collapsed ? 0 : width),
      bottom: LINE_H,
      toJSON() {},
    } as DOMRect;
  };
  proto.getBoundingClientRect = function getBoundingClientRect() {
    return boxOf(this);
  };
  proto.getClientRects = function getClientRects() {
    const rect = boxOf(this);
    return {
      length: 1,
      0: rect,
      item: (i: number) => (i === 0 ? rect : null),
      [Symbol.iterator]: function* () {
        yield rect;
      },
    } as unknown as DOMRectList;
  };
}

describe("docSubMarkHit", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("charIndexAtPoint lands in word 3, not 20 characters away", () => {
    mockRangeGeometry();
    const p = document.createElement("p");
    //           012345678901234567890123456789012345678
    p.textContent = "one two three four five six seven";
    document.body.append(p);
    const text = p.firstChild as Text;
    // "three" is [8, 13). Center of 'h' in three ≈ offset 10 → x = 10*8 + 4 = 84
    const index = charIndexAtPoint(text, 8 * 10 + 4, LINE_H / 2);
    expect(index).not.toBeNull();
    expect(index!).toBeGreaterThanOrEqual(8);
    expect(index!).toBeLessThanOrEqual(13);
  });

  it("charOffsetAtPoint maps pointer on word 3 to that word's stream offset", () => {
    mockRangeGeometry();
    const root = document.createElement("div");
    root.textContent = "one two three four five six seven";
    document.body.append(root);
    const hit = charOffsetAtPoint(root, 8 * 10 + 4, LINE_H / 2);
    expect(hit).not.toBeNull();
    expect(hit!.start).toBeGreaterThanOrEqual(8);
    expect(hit!.start).toBeLessThanOrEqual(13);
  });
});
