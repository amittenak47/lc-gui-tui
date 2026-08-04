import { describe, expect, it } from "vitest";

import {
  minTextBox,
  textClientFromScene,
  textEditorAnchor,
  textPlaceRect,
  textSceneFromClient,
  TEXT_TAP_SLOP_PX,
  type TextPlaceViewport,
} from "./textPlacement";

const viewport: TextPlaceViewport = {
  zoom: 2,
  scrollX: 30,
  scrollY: -10,
  offsetLeft: 40,
  offsetTop: 8,
};

describe("text placement coordinates", () => {
  it("round-trips scene ↔ client through the same viewport", () => {
    const scene = textSceneFromClient(300, 200, viewport);
    const back = textClientFromScene(scene.x, scene.y, viewport);
    expect(back.x).toBeCloseTo(300);
    expect(back.y).toBeCloseTo(200);
  });

  it("matches excalidraw's viewport formula", () => {
    // (client - offset) / zoom - scroll
    expect(textSceneFromClient(240, 108, viewport)).toEqual({ x: 70, y: 60 });
  });
});

describe("minTextBox", () => {
  it("scales the box with the font so a caret is always visible", () => {
    const small = minTextBox(12, 1);
    const large = minTextBox(48, 1);
    expect(large.width).toBeGreaterThan(small.width);
    expect(large.height).toBeGreaterThan(small.height);
  });

  it("keeps a tappable screen size when the board is zoomed out", () => {
    const zoomedOut = minTextBox(20, 0.1);
    // Scene units grow as zoom shrinks, so the on-screen box stays put.
    expect(zoomedOut.width * 0.1).toBeGreaterThanOrEqual(96);
    expect(zoomedOut.height * 0.1).toBeGreaterThanOrEqual(28);
  });
});

describe("textPlaceRect", () => {
  const flat: TextPlaceViewport = {
    zoom: 1,
    scrollX: 0,
    scrollY: 0,
    offsetLeft: 0,
    offsetTop: 0,
  };

  it("treats a press that barely moves as a tap and lets the box grow", () => {
    const rect = textPlaceRect(
      { x: 100, y: 100 },
      { x: 100 + TEXT_TAP_SLOP_PX, y: 100 + TEXT_TAP_SLOP_PX },
      flat,
      20,
    );
    expect(rect.autoResize).toBe(true);
    expect(rect.x).toBe(100);
    expect(rect.y).toBe(100);
    expect(rect).toMatchObject(minTextBox(20, 1));
  });

  it("keeps the drawn width when the press is dragged", () => {
    const rect = textPlaceRect({ x: 100, y: 100 }, { x: 500, y: 300 }, flat, 20);
    expect(rect.autoResize).toBe(false);
    expect(rect.width).toBe(400);
    expect(rect.height).toBe(200);
  });

  it("normalises a drag made up and to the left", () => {
    const rect = textPlaceRect({ x: 500, y: 300 }, { x: 100, y: 100 }, flat, 20);
    expect(rect.x).toBe(100);
    expect(rect.y).toBe(100);
    expect(rect.width).toBe(400);
    expect(rect.height).toBe(200);
  });

  it("refuses a box too narrow to fit a word", () => {
    const rect = textPlaceRect({ x: 100, y: 100 }, { x: 118, y: 400 }, flat, 20);
    const min = minTextBox(20, 1);
    expect(rect.autoResize).toBe(false);
    expect(rect.width).toBeCloseTo(min.width * 0.35);
  });

  it("gives a dragged box at least one line of height", () => {
    const rect = textPlaceRect({ x: 100, y: 100 }, { x: 400, y: 104 }, flat, 20);
    expect(rect.height).toBe(minTextBox(20, 1).height);
  });

  it("places in scene units under zoom and scroll", () => {
    const rect = textPlaceRect({ x: 240, y: 108 }, { x: 240, y: 108 }, viewport, 20);
    expect(rect.x).toBe(70);
    expect(rect.y).toBe(60);
  });
});

describe("textEditorAnchor", () => {
  it("aims inside the box, near the first line", () => {
    const rect = { x: 100, y: 100, width: 400, height: 300, autoResize: false };
    const anchor = textEditorAnchor(rect);
    expect(anchor.x).toBeGreaterThan(rect.x);
    expect(anchor.x).toBeLessThan(rect.x + rect.width);
    expect(anchor.y).toBeGreaterThan(rect.y);
    // Not the centre: a tall empty box's middle can fall outside what
    // Excalidraw hit-tests as the element.
    expect(anchor.y).toBeLessThan(rect.y + rect.height / 2);
  });

  it("stays inside a box smaller than the inset", () => {
    const rect = { x: 0, y: 0, width: 6, height: 5, autoResize: true };
    const anchor = textEditorAnchor(rect);
    expect(anchor.x).toBeLessThanOrEqual(rect.width);
    expect(anchor.y).toBeLessThanOrEqual(rect.height);
  });
});
