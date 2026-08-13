import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERASER_WIDTH_MAX } from "../canvas/rasterInk";
import { selectHoldYieldsToScroll } from "./gesture";
import { loadInkToolPrefs } from "./inkToolPrefs";
import { TEST_STRIP_POINTS, testStripDrawOp } from "./inkPresetStrip";
import {
  applyWedge,
  eraserWedgeFill,
  loadInkToolPresets,
  saveWedge,
  specCardSide,
  wedgeAt,
  wheelAutoApply,
  wheelConfirmEnabled,
  wheelHoldOutcome,
  type InkDrawSnapshot,
  type InkEraserSnapshot,
} from "./inkToolPresets";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

const draw: InkDrawSnapshot = {
  name: "Heading",
  width: 5,
  colour: "#6d7eae",
  fullness: 1,
  pressureSensitive: false,
  straightInk: true,
  pressureClip: 1,
  smoothing: 0.2,
  smoothingMode: "lift",
  speed: 0,
  blot: 0.55,
  boldness: 1,
};

const eraser: InkEraserSnapshot = {
  name: "Wide",
  eraserWidth: 96,
  partialErase: false,
};

describe("inkToolPresets", () => {

  it("defaults Global to live prefs and locks the wheel", () => {
    const store = loadInkToolPresets();
    expect(store.wheelLocked).toBe(true);
    expect(store.colorWheelOnToolbar).toBe(false);
    expect(store.tapOk).toBe(true);
    expect(wedgeAt(store, "pen", 0)?.name).toBe("Global");
    expect(store.custom.pen.every((slot) => slot == null)).toBe(true);
  });

  it("applies a custom snapshot without rewriting Global", () => {
    let store = loadInkToolPresets();
    const globalWidth = store.globalDraw.width;
    store = saveWedge(store, "pen", 2, draw);
    store = applyWedge(store, "pen", 2);
    expect(loadInkToolPrefs().penWidth).toBe(5);
    expect(loadInkToolPrefs().inkColor).toBe("#6d7eae");
    expect(loadInkToolPresets().globalDraw.width).toBe(globalWidth);
    expect(loadInkToolPresets().lastWedge.pen).toBe(2);
  });

  it("applying Global restores stored defaults after a custom wedge", () => {
    let store = loadInkToolPresets();
    const globalWidth = store.globalDraw.width;
    store = saveWedge(store, "pen", 2, draw);
    store = applyWedge(store, "pen", 2);
    store = applyWedge(store, "pen", 0);
    expect(loadInkToolPrefs().penWidth).toBe(globalWidth);
    expect(loadInkToolPresets().lastWedge.pen).toBe(0);
  });

  it("eraser wedges ignore ink colour and scale pink by nib", () => {
    let store = loadInkToolPresets();
    store = saveWedge(store, "eraser", 1, eraser);
    const slot = wedgeAt(store, "eraser", 1);
    expect(slot && "colour" in slot).toBe(false);
    expect(eraserWedgeFill(0)).not.toBe(eraserWedgeFill(ERASER_WIDTH_MAX));
    const tWide = eraserWedgeFill(ERASER_WIDTH_MAX);
    const tThin = eraserWedgeFill(1);
    expect(tWide).toMatch(/^rgb\(/);
    expect(tThin).not.toBe(tWide);
  });

  it("caps custom slots at 5 and leaves empty wedges hollow", () => {
    let store = loadInkToolPresets();
    for (let i = 1; i <= 5; i++) {
      store = saveWedge(store, "pen", i, { ...draw, name: `P${i}` });
    }
    expect(store.custom.pen).toHaveLength(5);
    expect(wedgeAt(store, "highlighter", 3)).toBeNull();
  });
});

describe("wheel confirm / hold", () => {
  it("disables hub until the pair differs from the open defaults", () => {
    expect(
      wheelConfirmEnabled({
        openKind: "pen",
        openWedge: 0,
        selectedKind: "pen",
        selectedWedge: 0,
      }),
    ).toBe(false);
    expect(
      wheelConfirmEnabled({
        openKind: "pen",
        openWedge: 0,
        selectedKind: "pen",
        selectedWedge: 2,
      }),
    ).toBe(true);
    expect(
      wheelConfirmEnabled({
        openKind: "pen",
        openWedge: 0,
        selectedKind: "highlighter",
        selectedWedge: null,
      }),
    ).toBe(false);
  });

  it("places the spec card right when there is room, else left", () => {
    expect(specCardSide(400, 124, 180, 900)).toBe("right");
    expect(specCardSide(800, 124, 180, 900)).toBe("left");
  });

  it("starts ink if the nib moves before the dwell, else opens the wheel", () => {
    expect(wheelHoldOutcome(17, 100)).toBe("ink");
    expect(wheelHoldOutcome(2, 200)).toBe("pending");
    expect(wheelHoldOutcome(2, 280)).toBe("wheel");
    expect(wheelHoldOutcome(9, 50)).toBe("pending");
    expect(wheelHoldOutcome(9, 280)).toBe("wheel");
  });

  it("yields a post-arm marquee to a vertical reading pan", () => {
    expect(selectHoldYieldsToScroll(4, 20)).toBe(true);
    expect(selectHoldYieldsToScroll(24, 6)).toBe(false);
    expect(selectHoldYieldsToScroll(-8, -8)).toBe(false);
  });

  it("auto-applies only after outer then a new inner, when Tap OK is off", () => {
    expect(
      wheelAutoApply({
        tapOk: true,
        outerDone: true,
        openKind: "pen",
        openWedge: 0,
        selectedKind: "pen",
        selectedWedge: 2,
      }),
    ).toBe(false);
    expect(
      wheelAutoApply({
        tapOk: false,
        outerDone: false,
        openKind: "pen",
        openWedge: 0,
        selectedKind: "highlighter",
        selectedWedge: 1,
      }),
    ).toBe(false);
    expect(
      wheelAutoApply({
        tapOk: false,
        outerDone: true,
        openKind: "pen",
        openWedge: 0,
        selectedKind: "pen",
        selectedWedge: 0,
      }),
    ).toBe(false);
    expect(
      wheelAutoApply({
        tapOk: false,
        outerDone: true,
        openKind: "pen",
        openWedge: 0,
        selectedKind: "highlighter",
        selectedWedge: 1,
      }),
    ).toBe(true);
  });
});

describe("test strip", () => {
  it("keeps the same polyline when knobs match", () => {
    const a = testStripDrawOp("pen", draw);
    const b = testStripDrawOp("pen", draw);
    const wider = testStripDrawOp("pen", { ...draw, width: 9 });
    expect(a).toEqual(b);
    expect(a?.points).toHaveLength(TEST_STRIP_POINTS.length);
    expect(wider?.points).toHaveLength(a?.points.length ?? 0);
    expect(wider?.baseWidth).toBe(9);
    expect(testStripDrawOp("eraser", eraser)).toBeNull();
  });
});
