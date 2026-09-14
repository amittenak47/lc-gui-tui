import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { layoutSceneText } from "./sceneTextLayout";
import { scaleElement } from "./shapeGesture";

const ctx = createCanvas(500, 500).getContext("2d") as unknown as CanvasRenderingContext2D;

describe("scene text layout", () => {
  it("wraps a paragraph inside its width without squeezing glyphs", () => {
    const text = "Let T(i) represent the length of the longest divisible subsequence of B[1..i].";
    const layout = layoutSceneText({ text, width: 180, fontSize: 24, autoResize: false }, ctx);
    expect(layout.lines.length).toBeGreaterThan(2);
    for (const line of layout.lines) expect(ctx.measureText(line).width).toBeLessThanOrEqual(180);
    expect(layout.height).toBe(layout.lines.length * 30);
    expect(layout.originalText).toBe(text);
  });
  it("reflows from the original words, keeping explicit blank lines and trailing newlines", () => {
    const originalText = "A long first line that wraps\n\nSecond line\n";
    const narrow = layoutSceneText({ originalText, width: 80, fontSize: 20, autoResize: false }, ctx);
    const wide = layoutSceneText({ ...narrow, width: 600, autoResize: false }, ctx);
    expect(wide.text).toBe(originalText);
    expect(wide.lines).toHaveLength(4);
  });
  it("wraps a long URL without dropping characters", () => {
    const text = "https://example.com/averylongpathwithnospaces";
    const result = layoutSceneText({ text, fontSize: 20, width: 100, autoResize: false }, ctx);
    expect(result.lines.join("")).toBe(text);
    result.lines.forEach((line) => expect(ctx.measureText(line).width).toBeLessThanOrEqual(100));
  });
  it("changes wrap width without changing font size when an edge is dragged", () => {
    const original = { type: "text", x: 10, y: 20, width: 300, height: 25, fontSize: 20,
      text: "A paragraph that needs several lines in a narrower box", autoResize: false };
    const next = scaleElement(original, "e", 110, 32);
    expect(next.fontSize).toBe(20);
    expect(next.width).toBe(100);
    expect(next.height).toBeGreaterThan(original.height);
    expect(next.x).toBe(10);
  });
});
