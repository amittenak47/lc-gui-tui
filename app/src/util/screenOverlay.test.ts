/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { screenOverlayOpen, watchScreenOverlay } from "./screenOverlay";

afterEach(() => {
  document.body.innerHTML = "";
});

/** MutationObserver delivers on a microtask; the watcher coalesces to a frame. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 24));
}

describe("screenOverlayOpen", () => {
  it("sees both backdrop conventions", () => {
    expect(screenOverlayOpen()).toBe(false);
    document.body.innerHTML = '<div class="lc-settings-backdrop"></div>';
    expect(screenOverlayOpen()).toBe(true);
    document.body.innerHTML = '<div class="lc-modal-backdrop"></div>';
    expect(screenOverlayOpen()).toBe(true);
  });

  it("finds one that is not a child of body", () => {
    // Settings is rendered in place, inside the app tree — not portalled.
    document.body.innerHTML =
      '<div class="lc-app"><main><div class="lc-settings-backdrop"></div></main></div>';
    expect(screenOverlayOpen()).toBe(true);
  });
});

describe("watchScreenOverlay", () => {
  it("reports the current state immediately", () => {
    document.body.innerHTML = '<div class="lc-settings-backdrop"></div>';
    const seen: boolean[] = [];
    const stop = watchScreenOverlay((open) => seen.push(open));
    // A pane mounting under an already-open dialog must not assume "closed".
    expect(seen).toEqual([true]);
    stop();
  });

  it("reports open and close", async () => {
    const seen: boolean[] = [];
    const stop = watchScreenOverlay((open) => seen.push(open));
    expect(seen).toEqual([false]);

    const dialog = document.createElement("div");
    dialog.className = "lc-settings-backdrop";
    document.body.appendChild(dialog);
    await settle();
    expect(seen).toEqual([false, true]);

    dialog.remove();
    await settle();
    expect(seen).toEqual([false, true, false]);
    stop();
  });

  it("says nothing when unrelated nodes come and go", async () => {
    const onChange = vi.fn();
    const stop = watchScreenOverlay(onChange);
    onChange.mockClear();
    for (let i = 0; i < 5; i += 1) {
      document.body.appendChild(document.createElement("span"));
    }
    await settle();
    // The board mutates constantly; only a change in the answer is an event.
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it("stops reporting once unsubscribed", async () => {
    const onChange = vi.fn();
    const stop = watchScreenOverlay(onChange);
    stop();
    onChange.mockClear();
    document.body.innerHTML = '<div class="lc-modal-backdrop"></div>';
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });
});
