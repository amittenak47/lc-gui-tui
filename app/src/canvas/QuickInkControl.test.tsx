/** @vitest-environment jsdom */
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuickInkControl, QUICK_INK_COLORS } from "./QuickInkControl";
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

it("opens bright colors on tap and switches an eraser to the quick pen on color pick", async () => {
  const pick = vi.fn();
  await act(async () => root.render(<QuickInkControl kind="eraser" color="#242424" onPick={pick} />));
  await press();
  const panel = document.querySelector('[aria-label="Quick ink colors"]')!;
  expect(panel.querySelectorAll("button")).toHaveLength(QUICK_INK_COLORS.length);
  await act(async () => (panel.querySelector('[aria-label="Red"]') as HTMLButtonElement).click());
  expect(pick).toHaveBeenCalledWith("pen", "#ef3340");
  expect(document.querySelector('[aria-label="Quick ink colors"]')).toBeNull();
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
