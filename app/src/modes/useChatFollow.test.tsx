/** @vitest-environment jsdom */
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatFollow } from "./useChatFollow";

let host: HTMLDivElement;
let root: Root;
let resized: () => void;
const disconnect = vi.fn();
const observe = vi.fn();
function Transcript({ open = true, scope = "room" }: { open?: boolean; scope?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useChatFollow(ref, scope, open);
  return <div ref={ref}><article>Revealing answer</article></div>;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  observe.mockClear(); disconnect.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it("follows expanding content only while the reader remains near the bottom", () => {
  act(() => root.render(<Transcript />));
  const list = host.firstElementChild as HTMLDivElement;
  let height = 500;
  Object.defineProperties(list, {
    scrollHeight: { get: () => height }, clientHeight: { value: 100 },
  });
  act(() => vi.advanceTimersByTime(16));
  expect(list.scrollTop).toBe(500);
  expect(observe).toHaveBeenCalledWith(list.firstElementChild);
  list.scrollTop = 100; list.dispatchEvent(new Event("scroll"));
  height = 600; resized();
  act(() => vi.advanceTimersByTime(16));
  expect(list.scrollTop).toBe(100);
  list.scrollTop = 500; list.dispatchEvent(new Event("scroll"));
  height = 700; resized();
  act(() => vi.advanceTimersByTime(16));
  expect(list.scrollTop).toBe(700);
});

it("resets following for a new thread and cancels pending work when closed", () => {
  act(() => root.render(<Transcript />));
  const list = host.firstElementChild as HTMLDivElement;
  Object.defineProperties(list, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
  act(() => vi.advanceTimersByTime(16));
  list.scrollTop = 100; list.dispatchEvent(new Event("scroll"));
  act(() => root.render(<Transcript scope="thread" />));
  act(() => vi.advanceTimersByTime(16));
  expect(list.scrollTop).toBe(500);
  resized();
  act(() => root.render(<Transcript scope="thread" open={false} />));
  expect(vi.getTimerCount()).toBe(0);
  expect(disconnect).toHaveBeenCalled();
});
