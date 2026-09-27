import { expect, it } from "vitest";
import { resolveInkColor } from "./inkColors";

it("keeps quick ink in the center without changing the wheel palette", () => {
  const palette = ["#333333", "#aaaaaa"];
  expect(resolveInkColor("paper", "#ff2d9a", palette)).toBe("#ff2d9a");
  expect(palette).toEqual(["#333333", "#aaaaaa"]);
  expect(resolveInkColor("paper", "#aaaaaa", palette)).toBe("#aaaaaa");
  expect(resolveInkColor("paper", null, palette)).toBe("#333333");
});
