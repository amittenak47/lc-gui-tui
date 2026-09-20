/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { installUiHandednessAttr, loadUiHandedness, saveUiHandedness } from "./uiHandedness";
import { applyHandednessAttr, loadInkHandedness, saveInkHandedness } from "./inkHandedness";
afterEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-handedness"); document.documentElement.removeAttribute("data-ui-handedness"); });
it("defaults to right independently of an existing left writer", () => {
  saveInkHandedness("left"); applyHandednessAttr("left");
  const stop = installUiHandednessAttr();
  expect(loadUiHandedness()).toBe("right");
  expect(document.documentElement.hasAttribute("data-ui-handedness")).toBe(false);
  expect(document.documentElement.getAttribute("data-handedness")).toBe("left"); stop();
});
it.each(["left", "right"] as const)("preserves %s ink hand across UI changes", ink => {
  saveInkHandedness(ink); applyHandednessAttr(ink);
  const stop = installUiHandednessAttr();
  for (const ui of ["left", "right"] as const) {
    saveUiHandedness(ui);
    expect(loadUiHandedness()).toBe(ui); expect(loadInkHandedness()).toBe(ink);
    expect(document.documentElement.getAttribute("data-ui-handedness")).toBe(ui === "left" ? "left" : null);
  } stop();
});
