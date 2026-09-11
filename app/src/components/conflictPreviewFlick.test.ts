/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import { attachOverflowFlick } from "./conflictPreviewFlick";

function fire(
  target: EventTarget,
  type: string,
  extra: { pointerId: number; clientY: number; pointerType?: string },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerType: "mouse", button: 0, ...extra });
  target.dispatchEvent(event);
}

describe("attachOverflowFlick", () => {
  it("drags scrollTop with the mouse", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(root, "clientHeight", { value: 400, configurable: true });
    root.scrollTop = 0;
    const stop = attachOverflowFlick(root);
    fire(root, "pointerdown", { pointerId: 1, clientY: 200 });
    fire(window, "pointermove", { pointerId: 1, clientY: 120 });
    expect(root.scrollTop).toBe(80);
    stop();
  });

  it("does not steal touch — native pan-y owns that", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(root, "clientHeight", { value: 400, configurable: true });
    root.scrollTop = 0;
    const stop = attachOverflowFlick(root);
    fire(root, "pointerdown", { pointerId: 1, clientY: 200, pointerType: "touch" });
    fire(window, "pointermove", { pointerId: 1, clientY: 120, pointerType: "touch" });
    expect(root.scrollTop).toBe(0);
    stop();
  });
});
