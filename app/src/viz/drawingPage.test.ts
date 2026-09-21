import { describe, expect, it } from "vitest";
import {
  bindDrawingPage,
  drawingIsOnScreen,
  pageForNewDrawing,
  pageFromDrawingScope,
  resolveDrawingPage,
} from "./drawingPage";

describe("drawingPage", () => {
  it("reads PDF scopes from footnotes, then the ask page", () => {
    expect(pageFromDrawingScope("p12")).toBe(12);
    expect(pageFromDrawingScope("page-3")).toBe(3);
    const marks = [{ id: "fn", anchor: { scope: "p47" } }];
    expect(pageForNewDrawing(["fn"], marks, 9)).toBe(47);
    expect(pageForNewDrawing([], marks, 9)).toBe(9);
    expect(pageForNewDrawing(["missing"], marks, null)).toBeUndefined();
  });

  it("keeps a stored page ahead of live footnotes", () => {
    expect(resolveDrawingPage(8, ["fn"], [{ id: "fn", anchor: { scope: "p2" } }])).toBe(8);
    expect(resolveDrawingPage(undefined, ["fn"], [{ id: "fn", anchor: { scope: "p2" } }])).toBe(2);
  });

  it("pins an unscoped drawing to the live page on a paged document", () => {
    expect(bindDrawingPage(undefined, undefined, 47, true, true)).toBe(47);
    expect(bindDrawingPage(undefined, 12, 47, true, true)).toBe(12);
    expect(bindDrawingPage(8, undefined, 47, true, true)).toBe(8);
    expect(bindDrawingPage(undefined, undefined, 1, true, false)).toBeUndefined();
    expect(bindDrawingPage(undefined, undefined, 47, false, true)).toBeUndefined();
  });

  it("hides a paged drawing once the camera leaves that page", () => {
    expect(drawingIsOnScreen(undefined, 50, [50])).toBe(true);
    expect(drawingIsOnScreen(undefined, 50, [50], true)).toBe(false);
    expect(drawingIsOnScreen(47, 47, [47, 48], true)).toBe(true);
    expect(drawingIsOnScreen(47, 50, [49, 50], true)).toBe(false);
    expect(drawingIsOnScreen(47, 50, [47, 50], true)).toBe(true);
    expect(drawingIsOnScreen(47, 50, [], true)).toBe(false);
    expect(drawingIsOnScreen(47, 0, [], true)).toBe(false);
  });
});
