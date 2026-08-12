/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";

import {
  horizontalScrollHost,
  horizontalScrollHostsIn,
  hostKeyInDoc,
  scrollHostAtPoint,
  scrollHostLookupFromSlot,
  slotCssPerScene,
} from "./scrollHost";

/** jsdom lays nothing out, so overflow is stated rather than measured. */
function sizeOf(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
}

function buildDoc(): { board: HTMLElement; doc: HTMLElement; pre: HTMLElement; code: HTMLElement } {
  const board = document.createElement("div");
  board.className = "lc-board";
  const slot = document.createElement("div");
  slot.className = "lc-page-content-slot";
  const doc = document.createElement("div");
  doc.className = "lc-md-ink-doc";
  const pre = document.createElement("pre");
  pre.style.overflowX = "auto";
  const code = document.createElement("code");
  pre.append(code);
  doc.append(pre);
  slot.append(doc);
  board.append(slot);
  document.body.append(board);
  sizeOf(doc, 400, 400);
  sizeOf(pre, 900, 400);
  sizeOf(code, 900, 900);
  return { board, doc, pre, code };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("horizontalScrollHost", () => {
  it("finds the codeblock from the text inside it", () => {
    const { pre, code } = buildDoc();
    expect(horizontalScrollHost(code)).toBe(pre);
    expect(horizontalScrollHost(pre)).toBe(pre);
  });

  it("ignores a codeblock whose lines already fit", () => {
    const { pre, code } = buildDoc();
    sizeOf(pre, 400, 400);
    expect(horizontalScrollHost(code)).toBeNull();
  });

  it("ignores a rounding fraction of overflow", () => {
    const { pre, code } = buildDoc();
    sizeOf(pre, 401, 400);
    expect(horizontalScrollHost(code)).toBeNull();
  });

  it("wants an overflow-x that actually scrolls", () => {
    const { pre, code } = buildDoc();
    pre.style.overflowX = "hidden";
    expect(horizontalScrollHost(code)).toBeNull();
    pre.style.overflowX = "scroll";
    expect(horizontalScrollHost(code)).toBe(pre);
  });

  it("stops at the markdown page — the board itself is never a host", () => {
    const { board, doc, code } = buildDoc();
    // Prose stays the page's: only a box inside the note can claim a gesture.
    doc.querySelector("pre")!.style.overflowX = "hidden";
    board.style.overflowX = "auto";
    sizeOf(board, 2000, 400);
    expect(horizontalScrollHost(code)).toBeNull();
  });

  it("is null outside a markdown page, and for a non-element target", () => {
    const { board } = buildDoc();
    const stray = document.createElement("div");
    board.append(stray);
    expect(horizontalScrollHost(stray)).toBeNull();
    expect(horizontalScrollHost(null)).toBeNull();
    expect(horizontalScrollHost(window)).toBeNull();
  });

  it("finds a scroller inside a whole-file code document", () => {
    const board = document.createElement("div");
    board.className = "lc-board";
    const slot = document.createElement("div");
    slot.className = "lc-page-content-slot";
    const doc = document.createElement("div");
    doc.className = "lc-code-doc";
    const pre = document.createElement("pre");
    pre.className = "lc-code-doc-pre";
    pre.style.overflowX = "auto";
    const code = document.createElement("code");
    pre.append(code);
    doc.append(pre);
    slot.append(doc);
    board.append(slot);
    document.body.append(board);
    sizeOf(doc, 400, 400);
    sizeOf(pre, 900, 400);
    sizeOf(code, 900, 900);
    expect(horizontalScrollHost(code)).toBe(pre);
  });

  /*
   * Host-bound ink: annotating still finds the scroller so stroke capture can
   * store hostKey + scrollLeftAtDraw. Paint translates + clips; do not disable
   * horizontal scroll while drawing.
   */
  it("still finds the host while annotating", () => {
    const board = document.createElement("div");
    board.className = "lc-board";
    const doc = document.createElement("div");
    doc.className = "lc-code-doc";
    const pre = document.createElement("pre");
    pre.style.overflowX = "auto";
    const code = document.createElement("code");
    pre.append(code);
    doc.append(pre);
    board.append(doc);
    document.body.append(board);
    sizeOf(doc, 400, 400);
    sizeOf(pre, 900, 400);
    sizeOf(code, 900, 900);

    expect(horizontalScrollHost(code)).toBe(pre);
  });

  it("assigns stable document-order hostKeys", () => {
    const { doc, pre } = buildDoc();
    const second = document.createElement("pre");
    second.style.overflowX = "auto";
    sizeOf(second, 800, 400);
    doc.append(second);
    const hosts = horizontalScrollHostsIn(doc);
    expect(hosts).toEqual([pre, second]);
    expect(hostKeyInDoc(pre, doc)).toBe(0);
    expect(hostKeyInDoc(second, doc)).toBe(1);
  });
});

describe("scrollHostAtPoint", () => {
  it("finds the host under an ink canvas overlay", () => {
    const { board, pre, code } = buildDoc();
    const ink = document.createElement("canvas");
    ink.className = "lc-raster-ink";
    board.append(ink);
    document.elementsFromPoint = () => [ink, code, pre];
    pre.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    expect(scrollHostAtPoint(10, 10)).toBe(pre);
  });

  it("finds the host when annotate PE:none keeps it out of the hit stack", () => {
    const { board, pre } = buildDoc();
    const ink = document.createElement("canvas");
    ink.className = "lc-raster-ink";
    board.append(ink);
    // Production annotate: page slot is pointer-events none — pre never appears.
    document.elementsFromPoint = () => [ink, board];
    pre.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    expect(scrollHostAtPoint(10, 10)).toBe(pre);
  });

  it("skips a host whose box does not contain the point", () => {
    const { board, pre, code } = buildDoc();
    const ink = document.createElement("canvas");
    ink.className = "lc-raster-ink";
    board.append(ink);
    document.elementsFromPoint = () => [ink, code, pre];
    pre.getBoundingClientRect = () =>
      ({ left: 200, top: 200, right: 300, bottom: 300, width: 100, height: 100 }) as DOMRect;
    expect(scrollHostAtPoint(10, 10)).toBeNull();
  });

  it("returns null when the stack has no scroll host", () => {
    const { board } = buildDoc();
    const ink = document.createElement("canvas");
    ink.className = "lc-raster-ink";
    board.append(ink);
    document.elementsFromPoint = () => [ink, board];
    expect(scrollHostAtPoint(10, 10)).toBeNull();
  });
});

describe("scrollHostLookupFromSlot", () => {
  it("maps hosts into page scene bounds", () => {
    const { board, pre } = buildDoc();
    const slot = board.querySelector(".lc-page-content-slot") as HTMLElement;
    Object.defineProperty(pre, "scrollLeft", { value: 42, configurable: true });
    slot.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    pre.getBoundingClientRect = () =>
      ({ left: 20, top: 10, right: 180, bottom: 90, width: 160, height: 80 }) as DOMRect;
    const pageBounds = { minX: 100, minY: 50, maxX: 300, maxY: 150 };
    const lookup = scrollHostLookupFromSlot(slot, pageBounds);
    expect(lookup).not.toBeNull();
    expect(lookup!.get(0)?.scrollLeft).toBe(42);
    expect(lookup!.get(0)?.bounds).toEqual({
      minX: 120,
      minY: 60,
      maxX: 280,
      maxY: 140,
    });
    expect(slotCssPerScene(slot, pageBounds)).toBeCloseTo(1);
  });
});
