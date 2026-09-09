/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import { attachOverflowFlick } from "./conflictPreviewFlick";

function fire(
  root: HTMLElement,
  type: string,
  extra: { pointerId: number; clientY: number; button?: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerType: "touch", ...extra });
  root.dispatchEvent(event);
}

describe("attachOverflowFlick", () => {
  it("drags scrollTop with the pointer", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(root, "clientHeight", { value: 400, configurable: true });
    root.scrollTop = 0;
    const stop = attachOverflowFlick(root);
    fire(root, "pointerdown", { pointerId: 1, clientY: 200 });
    fire(root, "pointermove", { pointerId: 1, clientY: 120 });
    expect(root.scrollTop).toBe(80);
    stop();
  });
});
