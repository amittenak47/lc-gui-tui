import { describe, expect, it } from "vitest";
import { drawingFitScale } from "./drawingFit";

describe("drawingFitScale", () => {
  it("fills the view instead of capping small drawings at 1.4×", () => {
    expect(drawingFitScale(400, 400, 100, 100)).toBeCloseTo(3.76, 2);
    expect(drawingFitScale(400, 200, 800, 100)).toBeCloseTo(0.47, 2);
  });
});
