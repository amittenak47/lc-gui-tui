/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";

import { horizontalScrollHost } from "./scrollHost";

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
   * The reported bug: ink drawn over a wide codeblock stayed put while the
   * block scrolled under it, so the annotation ended up over tokens it was
   * never about — and slid out past the block onto the prose beside it.
   *
   * The fix is the rule the rest of the document layer already follows: nothing
   * on the page scrolls its own contents, the board camera does all of it. This
   * is the half of that rule the gatekeeper enforces; the CSS shows the block's
   * full width so there is still a way to reach the rest of the line.
   */
  it("gives no host at all while annotating", () => {
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

    // Reading: the block owns a sideways drag, as it always did.
    expect(horizontalScrollHost(code, false)).toBe(pre);
    // Annotating: it does not, because the ink cannot follow it.
    expect(horizontalScrollHost(code, true)).toBeNull();
  });
});
