/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { HubSyncControl } from "./HubSyncControl";

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<HubSyncControl />));
  const button = host.querySelector(".lc-hub-sync") as HTMLButtonElement;
  return { host, root, button };
}

// The morph bar keeps every panel mounted (hidden ones are only
// aria-hidden), so read the label off whichever panel is active.
function activeLabel(button: HTMLButtonElement): string | null | undefined {
  return button.querySelector(".lc-morph-panel.is-active")?.textContent;
}

describe("HubSyncControl (step-2 stub)", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.textContent = "";
  });

  it("starts idle on Sync and walks the stage labels after one tap", () => {
    vi.useFakeTimers();
    const { button } = mount();
    expect(button.dataset.stage).toBe("idle");
    expect(activeLabel(button)).toBe("Sync");

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.dataset.stage).toBe("index");

    // One tap walks the whole pipeline; no further clicks needed.
    for (const next of ["pad", "ink", "links", "pull", "synced"]) {
      act(() => {
        vi.advanceTimersByTime(650);
      });
      expect(button.dataset.stage).toBe(next);
    }
    expect(button.dataset.stage).toBe("synced");
    expect(activeLabel(button)).toBe("Synced");
  });

  it("ignores taps mid-walk and resets to Sync once finished", () => {
    vi.useFakeTimers();
    const { button } = mount();

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.dataset.stage).toBe("index");

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.dataset.stage).toBe("index");

    // Chained timers reschedule on the effect flush after each step, so
    // walk one stage per act.
    for (let i = 0; i < 5; i++) {
      act(() => {
        vi.advanceTimersByTime(650);
      });
    }
    expect(button.dataset.stage).toBe("synced");

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.dataset.stage).toBe("idle");
    expect(activeLabel(button)).toBe("Sync");
  });
});
