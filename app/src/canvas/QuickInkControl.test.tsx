/** @vitest-environment jsdom */
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  nearestQuickEraserSize,
  placeQuickInkPanel,
  QUICK_ERASER_SIZES,
  QUICK_INK_COLORS,
  quickEraserDotPercent,
  QuickInkControl,
} from "./QuickInkControl";
import { PadTitle, PAD_TITLE_HOLD_MS, type PadTitleHandle } from "./PadTitle";
import { HOLD_MS } from "../util/gesture";
import type { InkPresetKind } from "../util/inkToolPresets";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const button = () => container.querySelector("button")!;
async function press(ms = 0) {
  await act(async () => button().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  await act(async () => vi.advanceTimersByTimeAsync(ms));
  await act(async () => button().dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
}

it("cycles pen, highlighter, eraser on hold without opening the colors", async () => {
  const picked = vi.fn();
  function Demo() {
    const [kind, setKind] = useState<InkPresetKind>("pen");
    return <QuickInkControl kind={kind} color="#2979ff" onPick={next => { picked(next); setKind(next); }} />;
  }
  await act(async () => root.render(<Demo />));
  await press(HOLD_MS + 30); await press(HOLD_MS + 30); await press(HOLD_MS + 30);
  expect(picked.mock.calls.map(call => call[0])).toEqual(["highlighter", "eraser", "pen"]);
  expect(document.querySelector('[aria-label="Quick ink colors"]')).toBeNull();
});

it("opens a row of color squares and keeps the current tool", async () => {
  const pick = vi.fn();
  await act(async () => root.render(<QuickInkControl kind="highlighter" color="#1a4dff" onPick={pick} />));
  await press();
  const panel = document.querySelector('[aria-label="Quick ink colors"]')!;
  expect(panel.querySelectorAll("button")).toHaveLength(QUICK_INK_COLORS.length);
  expect(panel.querySelector('[aria-label="Blue"]')?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => (panel.querySelector('[aria-label="Red"]') as HTMLButtonElement).click());
  expect(pick).toHaveBeenCalledWith("highlighter", "#ff2d2d");
  expect(document.querySelector('[aria-label="Quick ink colors"]')).toBeNull();
});

it("opens eraser sizes as scaled dots instead of colors", async () => {
  const pick = vi.fn();
  await act(async () => root.render(
    <QuickInkControl kind="eraser" color="#242424" eraserWidth={64} onPick={pick} />,
  ));
  await press();
  const panel = document.querySelector('[aria-label="Quick eraser sizes"]')!;
  expect(panel.querySelector('[aria-label="Red"]')).toBeNull();
  expect(panel.querySelectorAll("button")).toHaveLength(QUICK_ERASER_SIZES.length);
  const current = panel.querySelector('[aria-label="Eraser size 64"]') as HTMLButtonElement;
  expect(current.getAttribute("aria-pressed")).toBe("true");
  const small = current.querySelector<HTMLElement>(".lc-quick-ink-eraser")!;
  const large = panel.querySelector<HTMLElement>('[aria-label="Eraser size 384"] .lc-quick-ink-eraser')!;
  expect(parseFloat(large.style.width)).toBeGreaterThan(parseFloat(small.style.width));
  await act(async () => (panel.querySelector('[aria-label="Eraser size 192"]') as HTMLButtonElement).click());
  expect(pick).toHaveBeenCalledWith("eraser", undefined, 192);
  expect(document.querySelector('[aria-label="Quick eraser sizes"]')).toBeNull();
});

it("grows the eraser mark with the brush and picks the nearest size", () => {
  expect(quickEraserDotPercent(8)).toBeLessThan(quickEraserDotPercent(64));
  expect(quickEraserDotPercent(64)).toBeLessThan(quickEraserDotPercent(384));
  expect(nearestQuickEraserSize(70)).toBe(64);
  expect(nearestQuickEraserSize(100)).toBe(128);
});

it("parks the row on the button and clamps it inside the window", () => {
  const view = { width: 800, height: 600 };
  const panel = { width: 200, height: 34 };
  expect(placeQuickInkPanel({ left: 300, top: 500, bottom: 536, width: 36, height: 36 }, panel, view))
    .toEqual({ left: 218, top: 458 });
  expect(placeQuickInkPanel({ left: 760, top: 20, bottom: 56, width: 36, height: 36 }, panel, view))
    .toEqual({ left: 592, top: 64 });
  expect(placeQuickInkPanel({ left: 0, top: 0, bottom: 0, width: 0, height: 0 }, panel, view)).toBeNull();
});

it("follows the pen when the window resizes", async () => {
  let anchor = new DOMRect(80, 500, 36, 36);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("lc-quick-ink-colors")) return new DOMRect(0, 0, 220, 30);
    if (this.classList.contains("lc-quick-ink")) return anchor;
    return new DOMRect(0, 0, 0, 0);
  });
  await act(async () => root.render(<QuickInkControl kind="pen" color="#2979ff" onPick={() => {}} />));
  await press();
  const panel = document.querySelector<HTMLElement>('[aria-label="Quick ink colors"]')!;
  expect(panel.style.left).toBe("8px");
  anchor = new DOMRect(400, 200, 36, 36);
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(panel.style.left).toBe("308px");
  expect(panel.style.top).toBe("162px");
});

it("restores the last color and eraser size when the quick tool comes back", async () => {
  localStorage.removeItem("whiteboard.quickInk.v1");
  const picked = vi.fn();
  function Demo() {
    const [kind, setKind] = useState<InkPresetKind>("pen");
    return <QuickInkControl kind={kind} color="#1a1a1a" eraserWidth={8} onPick={(next, color, width) => {
      picked(next, color, width);
      setKind(next);
    }} />;
  }
  await act(async () => root.render(<Demo />));
  await press();
  await act(async () => (document.querySelector('[aria-label="Red"]') as HTMLButtonElement).click());
  await press(HOLD_MS + 30);
  await press(HOLD_MS + 30);
  await press();
  await act(async () => (document.querySelector('[aria-label="Eraser size 192"]') as HTMLButtonElement).click());
  await press(HOLD_MS + 30);
  await press(HOLD_MS + 30);
  await press(HOLD_MS + 30);
  const pen = picked.mock.calls.filter(call => call[0] === "pen").at(-1);
  const eraser = picked.mock.calls.filter(call => call[0] === "eraser").at(-1);
  expect(pen?.[1]).toBe("#ff2d2d");
  expect(eraser?.[2]).toBe(192);
  localStorage.removeItem("whiteboard.quickInk.v1");
});

it("removes title pixels after fading and protects a newer announcement", async () => {
  const ref = createRef<PadTitleHandle>();
  await act(async () => root.render(<PadTitle ref={ref} />));
  const title = container.querySelector<HTMLDivElement>(".lc-pad-title")!;
  expect(title.hidden).toBe(true);
  ref.current!.show("Whiteboard");
  expect(title.hidden).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(PAD_TITLE_HOLD_MS));
  expect(title.classList.contains("is-visible")).toBe(false);
  ref.current!.show("Next board");
  await act(async () => vi.advanceTimersByTimeAsync(420));
  expect(title.hidden).toBe(false);
  expect(title.textContent).toBe("Next board");
  await act(async () => vi.advanceTimersByTimeAsync(PAD_TITLE_HOLD_MS));
  expect(title.hidden).toBe(true);
  expect(title.textContent).toBe("");
});
