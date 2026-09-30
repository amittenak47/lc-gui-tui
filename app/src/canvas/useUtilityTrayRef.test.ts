/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { trayClearance, trayVisualHeight } from "./useUtilityTrayRef";

it("ignores a wake that hangs below the tray box", () => {
  const node = document.createElement("div");
  Object.defineProperty(node, "offsetHeight", { value: 36 });
  node.getBoundingClientRect = () =>
    ({ top: 200, bottom: 236, height: 36, left: 0, right: 36, width: 36, x: 0, y: 200, toJSON() {} }) as DOMRect;
  const wake = document.createElement("button");
  wake.className = "lc-chrome-wake";
  wake.getBoundingClientRect = () =>
    ({ top: 240, bottom: 276, height: 36, left: 0, right: 36, width: 36, x: 0, y: 240, toJSON() {} }) as DOMRect;
  node.append(wake);
  expect(trayVisualHeight(node)).toBe(36);
});

it("never clears less than the tray at rest while it morphs open", () => {
  const node = document.createElement("div");
  let height = 36;
  Object.defineProperty(node, "offsetHeight", { get: () => height });
  node.getBoundingClientRect = () => ({ height }) as DOMRect;
  expect(trayClearance(node)).toBe(36);
  // Mid-morph the tray is nearly nothing; the checker above must not dip.
  height = 1;
  expect(trayClearance(node)).toBe(36);
  height = 233;
  expect(trayClearance(node)).toBe(233);
});
