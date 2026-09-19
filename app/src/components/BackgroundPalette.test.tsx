/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BackgroundPalette } from "./BackgroundPalette";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = "";
});

it("opens the map theme list on the trigger and keeps it through a delayed mousedown", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(<BackgroundPalette variant="map" themeId="paper" onPick={() => {}} />),
  );
  const trigger = host.querySelector("button[aria-label='Theme']")!;
  expect(host.querySelector("[role='listbox']")).toBeNull();
  act(() => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(host.querySelector("[role='listbox']")).toBeTruthy();
  act(() =>
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })),
  );
  expect(host.querySelector("[role='listbox']")).toBeTruthy();
  act(() =>
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
  );
  expect(host.querySelector("[role='listbox']")).toBeNull();
  act(() => root.unmount());
});
