/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { AgentPanelSash } from "./AgentPanelSash";
import { SPLIT_RESIZE_EVENT, splitResizePhase } from "../util/splitResize";
import { AGENT_PANEL_WIDTH_DEFAULT } from "../util/agentPanelWidth";

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

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--lc-agent-width");
  document.documentElement.removeAttribute("data-ui-handedness");
  delete document.body.dataset.lcSashDrag;
});

function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  return event;
}

describe("AgentPanelSash", () => {
  it("widens the column toward the document and settles the boards", async () => {
    const app = document.createElement("div");
    app.className = "lc-app";
    const main = document.createElement("main");
    main.className = "lc-main";
    const board = document.createElement("div");
    board.className = "lc-board";
    const canvas = document.createElement("canvas");
    board.append(canvas);
    const wrap = document.createElement("div");
    wrap.className = "lc-canvas-wrap";
    wrap.append(board);
    main.append(wrap);
    const side = document.createElement("aside");
    side.className = "lc-side";
    app.append(main, side);
    document.body.append(app);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
    side.getBoundingClientRect = () =>
      ({ left: 760, right: 1280, top: 0, bottom: 800, width: 520, height: 800, x: 760, y: 0, toJSON() {} }) as DOMRect;
    const rect = { left: 0, top: 0, width: 760, height: 800, right: 760, bottom: 800 } as DOMRect;
    board.getBoundingClientRect = canvas.getBoundingClientRect = () => rect;
    const copy = vi.fn();
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage: copy } as unknown as CanvasRenderingContext2D);
    const phases: string[] = [];
    const onResize = (event: Event) => {
      const phase = splitResizePhase(event);
      if (phase) phases.push(phase);
    };
    window.addEventListener(SPLIT_RESIZE_EVENT, onResize);
    const root = createRoot(side);
    try {
      act(() => root.render(<AgentPanelSash />));
      const sash = side.querySelector<HTMLButtonElement>(".lc-agent-sash")!;
      act(() => sash.dispatchEvent(pointer("pointerdown", 760, 100)));
      expect(document.body.dataset.lcSashDrag).toBe("vertical");
      expect(copy).toHaveBeenCalled();
      act(() => window.dispatchEvent(pointer("pointermove", 640, 100)));
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      act(() => window.dispatchEvent(pointer("pointerup", 640, 100)));
      expect(document.body.dataset.lcSashDrag).toBeUndefined();
      expect(document.documentElement.style.getPropertyValue("--lc-agent-width")).toBe("640px");
      expect(localStorage.getItem("whiteboard.agent.panelWidth.v1")).toBe("640");
      expect(phases.at(-1)).toBe("settle");
    } finally {
      window.removeEventListener(SPLIT_RESIZE_EVENT, onResize);
      act(() => root.unmount());
      context.mockRestore();
      app.remove();
    }
  });

  it("double-click restores the default width", () => {
    const side = document.createElement("aside");
    side.className = "lc-side";
    document.body.append(side);
    side.getBoundingClientRect = () =>
      ({ left: 760, right: 1280, top: 0, bottom: 800, width: 520, height: 800, x: 760, y: 0, toJSON() {} }) as DOMRect;
    const root = createRoot(side);
    try {
      act(() => root.render(<AgentPanelSash />));
      const sash = side.querySelector<HTMLButtonElement>(".lc-agent-sash")!;
      act(() => sash.dispatchEvent(pointer("pointerdown", 760, 100)));
      act(() => sash.dispatchEvent(pointer("pointerdown", 760, 100)));
      expect(document.documentElement.style.getPropertyValue("--lc-agent-width")).toBe(`${AGENT_PANEL_WIDTH_DEFAULT}px`);
    } finally {
      act(() => root.unmount());
      side.remove();
    }
  });
});
