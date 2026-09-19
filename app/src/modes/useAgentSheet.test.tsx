/** @vitest-environment jsdom */
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { settleSheetHeight, useAgentSheet } from "./useAgentSheet";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); document.body.textContent = ""; });
it("snaps only near stops, clamps below header, and allows free sizes", () => {
  expect(settleSheetHeight(395, 800, 600, true)).toBe(400);
  expect(settleSheetHeight(350, 800, 600, true)).toBe(350);
  expect(settleSheetHeight(395, 800, 600, false)).toBe(395);
  expect(settleSheetHeight(900, 700, 600, false)).toBe(700);
  expect(settleSheetHeight(180, 120, 600, true)).toBe(120);
});
it("drags without rendering transcript, preserves height across hiding, and cancels safely", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  let renders = 0;
  function Panel({ open }: { open: boolean }) {
    renders++; const ref = useRef<HTMLElement>(null); const sheet = useAgentSheet(ref, true, open, () => {});
    return <aside ref={ref}><button onPointerDown={sheet.down} onPointerMove={sheet.move} onPointerUp={sheet.end} onPointerCancel={sheet.end}>Resize</button><p>Transcript</p></aside>;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  act(() => root.render(<Panel open />));
  const node = host.querySelector("aside")!; const button = host.querySelector("button")!;
  node.getBoundingClientRect = () => ({ height: 500 } as DOMRect);
  button.setPointerCapture = () => {}; button.hasPointerCapture = () => false;
  const send = (type: string, y: number) => act(() => { const e = new MouseEvent(type, { bubbles: true, clientY: y, button: 0 }); Object.defineProperty(e, "pointerId", { value: 1 }); button.dispatchEvent(e); });
  send("pointerdown", 600); const before = renders;
  for (let y = 599; y > 560; y--) send("pointermove", y);
  act(() => vi.advanceTimersByTime(17)); expect(renders).toBe(before);
  send("pointerup", 550); const height = node.style.height;
  act(() => root.render(<Panel open={false} />)); expect(node.inert).toBe(true); expect(node.style.visibility).toBe("hidden");
  act(() => root.render(<Panel open />)); expect(node.style.height).toBe(height);
  send("pointerdown", 500); send("pointermove", 300); send("pointercancel", 300);
  expect(node.style.height).toBe("500px");
  act(() => root.unmount());
});
