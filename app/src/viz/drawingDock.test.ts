import { describe, expect, it } from "vitest";
import {
  drawingDockSide,
  drawingSlideOffX,
  drawingStacksWithInk,
  inkChromeSide,
} from "./drawingDock";

describe("drawingDock", () => {
  it("parks opposite the agent", () => {
    expect(drawingDockSide("right")).toBe("left");
    expect(drawingDockSide("left")).toBe("right");
  });

  it("puts annotate chrome away from the writing palm", () => {
    expect(inkChromeSide("right")).toBe("left");
    expect(inkChromeSide("left")).toBe("right");
  });

  it("stacks the overlay with ink chrome when both hands match", () => {
    expect(drawingStacksWithInk("right", "right")).toBe(true);
    expect(drawingStacksWithInk("left", "left")).toBe(true);
    expect(drawingStacksWithInk("left", "right")).toBe(false);
    expect(drawingStacksWithInk("right", "left")).toBe(false);
  });

  it("slides off toward the docked edge", () => {
    expect(drawingSlideOffX("right")).toBe("110%");
    expect(drawingSlideOffX("left")).toBe("-110%");
  });
});
