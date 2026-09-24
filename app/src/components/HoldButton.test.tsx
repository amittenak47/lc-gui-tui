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
  it("does not fire a tap or dismiss an overlay on the click following a completed hold", async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const tap=vi.fn(), confirm=vi.fn(), outside=vi.fn();
    const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
    try {
      await act(async()=>root.render(<div onClick={outside}><HoldButton label="Menu" holdMs={200} onTap={tap} onConfirm={confirm}/></div>));
      const button=host.querySelector("button")!;
      await act(async()=>button.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerId:1})));
      now = 300;
      await act(async()=>vi.advanceTimersByTime(300));
      expect(confirm).toHaveBeenCalledTimes(1);
      await act(async()=>{
        button.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,pointerId:1}));
        button.click();
      });
      expect(tap).not.toHaveBeenCalled();
      expect(outside).not.toHaveBeenCalled();
    } finally {await act(async()=>root.unmount());host.remove();clock.mockRestore();vi.useRealTimers();}
  });
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

  it("confirms on release once the fill duration has elapsed", async () => {
    const onTap = vi.fn();
    const onConfirm = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HoldButton label="Test" onConfirm={onConfirm} onTap={onTap} holdMs={40} />,
      );
    });

    const button = host.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }),
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 55));
    });
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
