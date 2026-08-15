/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeAll } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { BrowserFilterSelect } from "./BrowserFilterSelect";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
  }
});

describe("BrowserFilterSelect", () => {
  it("shows Any Difficulty on the closed trigger", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <BrowserFilterSelect
          value=""
          placeholder="Any Difficulty"
          aria-label="Difficulty"
          options={[
            { value: "", label: "Any Difficulty" },
            { value: "Easy", label: "Easy" },
          ]}
          onChange={() => {}}
        />,
      );
    });

    const trigger = host.querySelector(".lc-filter-select-trigger") as HTMLButtonElement;
    expect(trigger.textContent).toBe("Any Difficulty");
    expect(document.querySelector(".lc-filter-select-morph")).toBeNull();

    await act(async () => {
      trigger.click();
    });
    expect(document.querySelector(".lc-morph-bar.lc-filter-select-morph")).toBeTruthy();
    expect(document.querySelector("[data-morph-id], .lc-morph-panel.is-active")).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
