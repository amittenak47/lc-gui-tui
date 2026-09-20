/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocSelectionLayer, type DocSelectionLayerProps } from "./DocSelectionLayer";
import { selectionCaptureFailure, type SelectionActionContext, type SelectionActionResult } from "./selectionAction";

let host: HTMLDivElement;
let root: Root;
const footnotes: NonNullable<DocSelectionLayerProps["footnotes"]> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(cb => { cb(0); return 1; });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => {
    return new DOMRect(0, 0, 800, 1000);
  });
  Range.prototype.getClientRects = () => [new DOMRect(30, 50, 150, 20)] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(30, 50, 150, 20);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); window.getSelection()?.removeAllRanges(); document.body.textContent = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
async function mount(onAskAgent: DocSelectionLayerProps["onAskAgent"]) {
  act(() => root.render(<DocSelectionLayer footnotes={footnotes} onAskAgent={onAskAgent}><p data-doc-scope="p1">Selected words for a question</p></DocSelectionLayer>));
  const text = host.querySelector("p")!.firstChild!;
  const range = document.createRange(); range.selectNodeContents(text);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  await act(async () => { text.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
}

it("keeps the selection after failed capture and opens text-only only on explicit tap", async () => {
  const draft = vi.fn();
  await mount((selection, _rect, context) => selectionCaptureFailure("Capture failed", selection.text, context, draft));
  const ask = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes("Ask Agent"))!;
  expect(ask).toBeTruthy();
  await act(async () => ask.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Capture failed");
  expect(button("Continue with text only")).toBeTruthy();
  expect(draft).not.toHaveBeenCalled();
  await act(async () => button("Continue with text only").click());
  expect(draft).toHaveBeenCalledTimes(1);
});

it("invalidates a pending capture on unmount", async () => {
  let context!: SelectionActionContext;
  let finish!: (result: SelectionActionResult) => void;
  await mount((_selection, _rect, current) => { context = current; return new Promise(resolve => { finish = resolve; }); });
  const ask = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes("Ask Agent"))!;
  await act(async () => ask.click());
  expect(context.isCurrent()).toBe(true);
  act(() => root.render(null));
  expect(context.isCurrent()).toBe(false);
  await act(async () => finish(true));
});

it("shows no continuation when the failed selection has no usable text", async () => {
  await mount((_selection, _rect, context) => selectionCaptureFailure("Image unavailable", "", context, vi.fn()));
  const ask = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes("Ask Agent"))!;
  await act(async () => ask.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Image unavailable");
  expect(button("Continue with text only")).toBeUndefined();
});

it("dismissal invalidates a capture before its late failure can offer a fallback", async () => {
  let context!: SelectionActionContext;
  let finish!: (result: SelectionActionResult) => void;
  const draft = vi.fn();
  await mount((_selection, _rect, current) => { context = current; return new Promise(resolve => { finish = resolve; }); });
  const ask = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes("Ask Agent"))!;
  await act(async () => ask.click());
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss selection actions"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true })));
  expect(context.isCurrent()).toBe(false);
  await act(async () => finish(selectionCaptureFailure("Late failure", "Words", context, draft)));
  expect(button("Continue with text only")).toBeUndefined();
  expect(draft).not.toHaveBeenCalled();
});
