/** @vitest-environment jsdom */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "./Timeline";
import type { VizProgram } from "./schema";

const program: VizProgram = { id: "walk", viz: "array", title: "Walk the array", frames: [0, 1, 2].map((i) => ({ label: `Visit ${i}`, cells: [1, 2, 3], pointers: { i }, highlight: [i], entries: [], note: `Read cell ${i}` })) };
let host: HTMLDivElement;
let root: Root;
let onFrame: ReturnType<typeof vi.fn>;
const click = async (name: string) => { await act(async () => { (host.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement).click(); }); };
const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  onFrame = vi.fn();
  await act(async () => { root.render(<StrictMode><Timeline program={program} onFrame={onFrame} playbackMs={1000} /></StrictMode>); });
  onFrame.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Timeline", () => {
  it("advances exactly once under StrictMode and stops on the final step", async () => {
    await click("Play");
    await tick(1000);
    expect(onFrame.mock.calls).toEqual([[1]]);
    await tick(1000);
    expect(onFrame.mock.calls).toEqual([[1], [2]]);
    expect(host.querySelector('[aria-label="Replay"]')).toBeTruthy();
    await tick(5000);
    expect(onFrame).toHaveBeenCalledTimes(2);
    await click("Replay");
    expect(onFrame).toHaveBeenLastCalledWith(0);
  });
  it("manual stepping pauses playback", async () => {
    await click("Play");
    await tick(500);
    await click("Next step");
    await tick(2000);
    expect(onFrame.mock.calls).toEqual([[1]]);
    expect(host.querySelector('[aria-label="Play"]')).toBeTruthy();
  });
  it("honours the chosen playback speed", async () => {
    await act(async () => {
      const select = host.querySelector("select")!;
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Play");
    await tick(499);
    expect(onFrame).not.toHaveBeenCalled();
    await tick(1);
    expect(onFrame).toHaveBeenLastCalledWith(1);
  });
  it("refreshes a same-id, same-length replacement", async () => {
    const replacement = { ...program, title: "A different walk" };
    await act(async () => root.render(<StrictMode><Timeline program={replacement} onFrame={onFrame} initialFrame={1} /></StrictMode>));
    expect(onFrame).toHaveBeenLastCalledWith(1);
    expect(host.textContent).toContain("Step 2 of 3");
  });
  it("cancels pending playback on unmount", async () => {
    await click("Play");
    await act(async () => root.render(null));
    await tick(5000);
    expect(onFrame).not.toHaveBeenCalled();
  });
});
