/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { SplitSash } from "./SplitSash";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  return event;
}

describe("SplitSash", () => {
  it("resizes from window pointermove after a parent re-render", () => {
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
    act(() => {
      window.dispatchEvent(pointer("pointermove", 300, 100));
    });
    expect(onRatio).toHaveBeenCalled();
    const last = onRatio.mock.calls.at(-1)?.[0] as number;
    expect(last).toBeCloseTo(0.3, 5);
    expect(host.style.getPropertyValue("--lc-split-a")).toBe(String(last));
    act(() => {
      window.dispatchEvent(pointer("pointerup", 300, 100));
      root.unmount();
      host.remove();
    });
  });
});
