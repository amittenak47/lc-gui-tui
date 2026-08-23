import { describe, expect, it } from "vitest";

import {
  contentSlotCssTransform,
  contentSlotPlaceAt,
  panDeltaBetweenPlaces,
  shouldSkipFrozenContentSlotReport,
} from "./contentSlotPlace";

const PAGE = { minX: 10, minY: 20, maxX: 770, maxY: 1120 };

describe("contentSlotPlaceAt", () => {
  it("moves top with live scrollY, not the committed camera", () => {
    const committed = contentSlotPlaceAt(0, 0, 1, PAGE, null);
    const live = contentSlotPlaceAt(0, -400, 1, PAGE, committed);
    expect(committed?.top).toBe(20);
    expect(live?.top).toBe(-380);
    expect(live?.left).toBe(committed?.left);
  });

  it("scales the same way the ink pan delta does", () => {
    const place = contentSlotPlaceAt(10, -5, 2, PAGE, null);
    expect(place).toEqual({
      left: (10 + 10) * 2,
      top: (20 - 5) * 2,
      sceneWidth: 760,
      zoom: 2,
      scrollX: 10,
      scrollY: -5,
    });
  });

  it("rides the last placement when the page box is missing for a sample", () => {
    const last = contentSlotPlaceAt(0, 0, 1, PAGE, null);
    const next = contentSlotPlaceAt(0, -200, 1, null, last);
    expect(next?.top).toBe((last?.top ?? 0) - 200);
    expect(next?.left).toBe(last?.left);
    expect(next?.sceneWidth).toBe(last?.sceneWidth);
  });

  it("cannot place a first sample with no page box and no last slot", () => {
    expect(contentSlotPlaceAt(0, -40, 1, null, null)).toBeNull();
  });

  it("lock: committed place plus pan delta is the live place", () => {
    const committed = contentSlotPlaceAt(0, 0, 1, PAGE, null);
    const live = contentSlotPlaceAt(0, -400, 1, PAGE, committed);
    expect(committed).not.toBeNull();
    expect(live).not.toBeNull();
    const { dx, dy } = panDeltaBetweenPlaces(committed!, live!);
    expect(committed!.left + dx).toBe(live!.left);
    expect(committed!.top + dy).toBe(live!.top);
  });
});

describe("contentSlotCssTransform", () => {
  it("is translate plus scale, never left/top", () => {
    const place = contentSlotPlaceAt(0, -40, 1.25, PAGE, null);
    expect(place).not.toBeNull();
    expect(contentSlotCssTransform(place!)).toBe(
      `translate(${place!.left}px, ${place!.top}px) scale(1.25)`,
    );
  });
});

describe("shouldSkipFrozenContentSlotReport", () => {
  it("blocks a frozen appState write while a pan translate is still on the ink", () => {
    expect(shouldSkipFrozenContentSlotReport(false, 0, -80)).toBe(true);
    expect(shouldSkipFrozenContentSlotReport(false, 12, 0)).toBe(true);
  });

  it("lets a live sample, or a settled camera with no leftover pan, report", () => {
    expect(shouldSkipFrozenContentSlotReport(true, 0, -80)).toBe(false);
    expect(shouldSkipFrozenContentSlotReport(false, 0, 0)).toBe(false);
  });
});
