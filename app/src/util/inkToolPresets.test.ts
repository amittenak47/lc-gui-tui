import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERASER_WIDTH_MAX, STROKE_WIDTH_DEFAULT } from "../canvas/rasterInk";
import { selectHoldYieldsToScroll } from "./gesture";
import { INK_BOLDNESS_DEFAULT, loadInkBoldness, saveInkBoldness } from "./inkBoldnessPref";
import { loadInkGrain, loadInkSpeedFade } from "./inkSpeedPref";
import { loadInkToolPrefs, saveInkToolPrefs } from "./inkToolPrefs";
import { drawOpFromSnap, TEST_STRIP_POINTS, testStripDrawOp } from "./inkPresetStrip";
import {
  applyWedge,
  defaultDrawSnapshot,
  defaultEraserSnapshot,
  eraserWedgeFill,
  liveDrawSnapshot,
  liveEraserSnapshot,
  loadInkToolPresets,
  saveWedge,
  specCardSide,
  wedgeAt,
  wheelAutoApply,
  wheelConfirmEnabled,
  wheelHoldIsDrawingHop,
  wheelHoldOutcome,
  wheelHoldTurn,
  writeLiveFromDraw,
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
  grain: 0,
  fade: 0,
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

  it("treats an old stored wedge without fade as 0", () => {
    const store = loadInkToolPresets();
    const { fade: _omit, ...old } = draw;
    localStorage.setItem(
      "whiteboard.inkToolPresets.v2",
      JSON.stringify({
        ...store,
        custom: { ...store.custom, pen: [old, null, null, null, null] },
      }),
    );
    const loaded = loadInkToolPresets();
    expect((loaded.custom.pen[0] as InkDrawSnapshot).fade).toBe(0);
  });

  it("treats an old stored wedge without grain as 0", () => {
    const store = loadInkToolPresets();
    const { grain: _omit, ...old } = draw;
    localStorage.setItem(
      "whiteboard.inkToolPresets.v2",
      JSON.stringify({
        ...store,
        custom: { ...store.custom, pen: [old, null, null, null, null] },
      }),
    );
    const loaded = loadInkToolPresets();
    expect((loaded.custom.pen[0] as InkDrawSnapshot).grain).toBe(0);
  });

  it("applying a wedge writes speed fade onto the live key", () => {
    let store = loadInkToolPresets();
    store = saveWedge(store, "pen", 1, { ...draw, speed: 0.2, fade: 0.4 });
    store = applyWedge(store, "pen", 1);
    expect(loadInkSpeedFade()).toBe(0.4);
  });

  it("applying a wedge writes grain onto the live key", () => {
    let store = loadInkToolPresets();
    store = saveWedge(store, "pen", 1, { ...draw, grain: 0.45 });
    store = applyWedge(store, "pen", 1);
    expect(loadInkGrain()).toBe(0.45);
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
  it("disables hub until the pair differs from the open defaults, unless a wedge was tapped", () => {
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
    expect(
      wheelConfirmEnabled({
        openKind: "pen",
        openWedge: 2,
        selectedKind: "pen",
        selectedWedge: 2,
        innerChosen: true,
      }),
    ).toBe(true);
  });

  it("places the spec card right when there is room, else left", () => {
    expect(specCardSide(400, 124, 180, 900)).toBe("right");
    expect(specCardSide(800, 124, 180, 900)).toBe("left");
  });

  it("starts ink on a directed stroke, else opens the wheel after a rest", () => {
    // Same spot, no path.
    expect(wheelHoldOutcome(2, 200)).toBe("pending");
    expect(wheelHoldOutcome(2, 280)).toBe("wheel");
    // Zig-zag: long path, small net — still a rest.
    expect(wheelHoldOutcome(3, 100, 14, 5)).toBe("pending");
    expect(wheelHoldOutcome(3, 280, 14, 5)).toBe("wheel");
    // Two hops the same way.
    expect(wheelHoldOutcome(8, 50, 8.4, 2)).toBe("ink");
    // One coalesced jump past clear.
    expect(wheelHoldOutcome(13, 40, 13, 1)).toBe("ink");
    // One hop in the bounce band — wait.
    expect(wheelHoldOutcome(8, 100, 8, 1)).toBe("pending");
    expect(wheelHoldOutcome(8, 280, 8, 1)).toBe("wheel");
    // Drifted zig-zag: net left the slop but folded back.
    expect(wheelHoldOutcome(8, 280, 20, 4)).toBe("wheel");
    // Bullet spiral: tiny net, heading keeps turning.
    expect(wheelHoldOutcome(2, 100, 16, 8, Math.PI)).toBe("ink");
    expect(wheelHoldTurn(1, 0, 0, 1)).toBeCloseTo(Math.PI / 2, 5);
    expect(wheelHoldTurn(1, 0, -1, 0)).toBe(0);
    // Fine writing: tiny continuing hops. Jitter reversal is not.
    expect(wheelHoldIsDrawingHop(1.2, 0, 1.1, 0.2)).toBe(true);
    expect(wheelHoldIsDrawingHop(1, 0, -1, 0)).toBe(false);
    expect(wheelHoldIsDrawingHop(0.3, 0, 0.3, 0)).toBe(false);
  });

  it("yields a post-arm marquee to a vertical reading pan", () => {
    expect(selectHoldYieldsToScroll(4, 20)).toBe(true);
    expect(selectHoldYieldsToScroll(24, 6)).toBe(false);
    expect(selectHoldYieldsToScroll(-8, -8)).toBe(false);
  });

  it("auto-applies only after an inner tap, when Tap OK is off", () => {
    expect(
      wheelAutoApply({
        tapOk: true,
        outerDone: true,
        openKind: "pen",
        openWedge: 0,
        selectedKind: "pen",
        selectedWedge: 2,
        innerChosen: true,
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
        selectedKind: "pen",
        selectedWedge: 2,
        innerChosen: true,
      }),
    ).toBe(true);
    // Re-tapping the already-live wedge still applies (pointerup, not the
    // lastWedge seed). Hover / linger must not set innerChosen.
    expect(
      wheelAutoApply({
        tapOk: false,
        outerDone: true,
        openKind: "pen",
        openWedge: 0,
        selectedKind: "pen",
        selectedWedge: 0,
        innerChosen: true,
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
    expect(a?.speedFade).toBe(0);
    expect(testStripDrawOp("pen", { ...draw, fade: 0.4 })?.speedFade).toBe(0.4);
    expect(testStripDrawOp("eraser", eraser)).toBeNull();
  });

  it("builds a live-pad op from the draft points, not the strip polyline", () => {
    const pts = [{ x: 1, y: 2, pressure: 0.5 }];
    const op = drawOpFromSnap("pen", draw, pts);
    expect(op?.points).toEqual(pts);
    expect(op?.points).not.toBe(TEST_STRIP_POINTS);
    expect(drawOpFromSnap("eraser", eraser, pts)).toBeNull();
  });
});

describe("Reset stock snapshots", () => {
  it("ignores live device prefs so Reset can escape an invisible pen", () => {
    saveInkBoldness(0);
    saveInkToolPrefs({
      ...loadInkToolPrefs(),
      penWidth: 32,
      straightInk: true,
      pressureSensitive: false,
    });
    const stock = defaultDrawSnapshot("Preset");
    expect(stock.boldness).toBe(INK_BOLDNESS_DEFAULT);
    expect(stock.width).toBe(STROKE_WIDTH_DEFAULT);
    expect(stock.straightInk).toBe(false);
    expect(stock.pressureSensitive).toBe(true);
    expect(stock.speed).toBe(0);
    expect(stock.blot).toBe(0);
    expect(stock.grain).toBe(0);
    expect("body" in stock).toBe(false);
    expect(liveDrawSnapshot().boldness).toBe(0);
    expect(liveDrawSnapshot().width).toBe(32);
  });

  it("stock eraser ignores live eraser width", () => {
    saveInkToolPrefs({ ...loadInkToolPrefs(), eraserWidth: 96 });
    expect(defaultEraserSnapshot("E").eraserWidth).toBe(STROKE_WIDTH_DEFAULT);
    expect(liveEraserSnapshot().eraserWidth).toBe(96);
  });

  it("saving a reset snapshot writes stock onto live keys", () => {
    const stock = defaultDrawSnapshot("Heading");
    writeLiveFromDraw(stock, loadInkToolPrefs());
    expect(loadInkToolPrefs().penWidth).toBe(STROKE_WIDTH_DEFAULT);
    expect(loadInkBoldness()).toBe(INK_BOLDNESS_DEFAULT);
    let store = loadInkToolPresets();
    store = saveWedge(store, "pen", 1, stock);
    store = applyWedge(store, "pen", 1);
    expect(loadInkToolPrefs().penWidth).toBe(STROKE_WIDTH_DEFAULT);
    expect(wedgeAt(store, "pen", 1)).toMatchObject({
      width: STROKE_WIDTH_DEFAULT,
      boldness: INK_BOLDNESS_DEFAULT,
    });
  });
});
