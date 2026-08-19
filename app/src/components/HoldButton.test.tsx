/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { HoldButton } from "./HoldButton";

beforeAll(() => {
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function () {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function () {
      return false;
    };
  }
  if (typeof PointerEvent === "undefined") {
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    // @ts-expect-error jsdom lacks PointerEvent
    globalThis.PointerEvent = FakePointerEvent;
  }
});

describe("HoldButton", () => {
  it("fires onTap after leave-then-up while the pointer is captured", async () => {
    const onTap = vi.fn();
    const onConfirm = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HoldButton label="Test" onConfirm={onConfirm} onTap={onTap} holdMs={10_000} />,
      );
    });

    const button = host.querySelector("button")!;
    const captureSpy = vi
      .spyOn(button, "setPointerCapture")
      .mockImplementation(() => undefined);

    await act(async () => {
      button.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }),
      );
    });
    expect(captureSpy).toHaveBeenCalled();

    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerId: 1 }));
    });
    expect(onTap).not.toHaveBeenCalled();

    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    });

    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("does not wash fill on a tap when onTap is set", async () => {
    const onTap = vi.fn();
    const onConfirm = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HoldButton label="Test" onConfirm={onConfirm} onTap={onTap} holdMs={10_000} />,
      );
    });

    const button = host.querySelector("button")!;

    await act(async () => {
      button.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }),
      );
    });
    expect(button.style.getPropertyValue("--lc-hold") || "0").toBe("0");

    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    });

    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button.style.getPropertyValue("--lc-hold") || "0").toBe("0");

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("starts fill immediately when there is no onTap", async () => {
    const onConfirm = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<HoldButton label="Test" onConfirm={onConfirm} holdMs={10_000} />);
    });

    const button = host.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }),
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const hold = Number(button.style.getPropertyValue("--lc-hold") || "0");
    expect(hold).toBeGreaterThan(0);
    expect(onConfirm).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
