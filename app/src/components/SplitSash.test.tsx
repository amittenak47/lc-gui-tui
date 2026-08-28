/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { SplitSash } from "./SplitSash";
import { SPLIT_RESIZE_EVENT, splitResizePhase } from "../util/splitResize";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};
    Element.prototype.hasPointerCapture = function () {
      return true;
    };
  }
});

function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  return event;
}

describe("SplitSash", () => {
  it("writes CSS vars on move and commits the ratio on pointerup", () => {
    const onRatio = vi.fn();
    const host = document.createElement("div");
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }),
    });
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<SplitSash axis="vertical" onRatio={onRatio} />);
    });
    const sash = host.querySelector<HTMLButtonElement>(".lc-split-sash");
    expect(sash).not.toBeNull();
    act(() => {
      sash!.dispatchEvent(pointer("pointerdown", 500, 100));
    });
    expect(sash!.className).toContain("is-dragging");
    expect(document.body.dataset.lcSashDrag).toBe("vertical");
    act(() => {
      window.dispatchEvent(pointer("pointermove", 300, 100));
    });
    expect(onRatio).not.toHaveBeenCalled();
    expect(host.style.getPropertyValue("--lc-split-a")).toBe("0.3");
    expect(host.style.getPropertyValue("--lc-split-b")).toBe("0.7");
    act(() => {
      window.dispatchEvent(pointer("pointerup", 300, 100));
    });
    expect(onRatio).toHaveBeenCalledTimes(1);
    expect(onRatio.mock.calls[0]?.[0]).toBeCloseTo(0.3, 5);
    expect(document.body.dataset.lcSashDrag).toBeUndefined();
    act(() => {
      root.unmount();
      host.remove();
    });
  });

  it("still resizes when the board under the finger stops bubbling", () => {
    const onRatio = vi.fn();
    const host = document.createElement("div");
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }),
    });
    document.body.appendChild(host);
    const board = document.createElement("div");
    document.body.appendChild(board);
    board.addEventListener("pointermove", (event) => event.stopPropagation());
    const root = createRoot(host);
    act(() => {
      root.render(<SplitSash axis="vertical" onRatio={onRatio} />);
    });
    const sash = host.querySelector<HTMLButtonElement>(".lc-split-sash")!;
    act(() => {
      sash.dispatchEvent(pointer("pointerdown", 500, 100));
    });
    act(() => {
      board.dispatchEvent(pointer("pointermove", 220, 100));
    });
    expect(onRatio).not.toHaveBeenCalled();
    expect(host.style.getPropertyValue("--lc-split-a")).toBe("0.22");
    act(() => {
      window.dispatchEvent(pointer("pointerup", 220, 100));
      root.unmount();
      host.remove();
      board.remove();
    });
    expect(onRatio).toHaveBeenCalledTimes(1);
    expect(onRatio.mock.calls[0]?.[0]).toBeCloseTo(0.22, 5);
  });

  it("acts on each pointer move once", () => {
    // The handler was bound to `window` *and* `document`, so an ordinary move
    // reached both: two layout reads, two CSS writes, two board resizes.
    const moves: string[] = [];
    const listener = (event: Event) => {
      const phase = splitResizePhase(event);
      if (phase) moves.push(phase);
    };
    window.addEventListener(SPLIT_RESIZE_EVENT, listener);
    const host = document.createElement("div");
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }),
    });
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<SplitSash axis="vertical" onRatio={vi.fn()} />);
    });
    const sash = host.querySelector<HTMLButtonElement>(".lc-split-sash")!;
    act(() => {
      sash.dispatchEvent(pointer("pointerdown", 500, 100));
    });
    // Pressing down is itself a move; the count that matters starts after it.
    moves.length = 0;
    act(() => {
      window.dispatchEvent(pointer("pointermove", 300, 100));
    });
    expect(moves).toEqual(["move"]);
    act(() => {
      window.dispatchEvent(pointer("pointerup", 300, 100));
      root.unmount();
      host.remove();
    });
    window.removeEventListener(SPLIT_RESIZE_EVENT, listener);
  });

  it("clears the body drag flag when the split closes mid-drag", () => {
    // `data-lc-sash-drag` carries `pointer-events: none !important` for every
    // board. Unmount used to drop the listeners and leave the attribute, so a
    // split closed during a drag left the whole canvas dead to the pointer.
    const host = document.createElement("div");
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }),
    });
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<SplitSash axis="vertical" onRatio={vi.fn()} />);
    });
    const sash = host.querySelector<HTMLButtonElement>(".lc-split-sash")!;
    act(() => {
      sash.dispatchEvent(pointer("pointerdown", 500, 100));
    });
    expect(document.body.dataset.lcSashDrag).toBe("vertical");

    act(() => {
      root.unmount();
      host.remove();
    });
    expect(document.body.dataset.lcSashDrag).toBeUndefined();
  });
});
