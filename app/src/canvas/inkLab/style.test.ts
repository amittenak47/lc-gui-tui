import { describe, expect, it } from "vitest";

import { dryWashRgb } from "../rasterInk";
import { capillaryRelax, growTipRadius, INK_HEX, labCssSpeedFromSlowness, labHoldGrow, labNibSizeFromUiWidth, labPenDot, labPenFromToolbar, labPreviewSpine, labPressureAmt, labSwellHoldPool, washRgb } from "./style";

describe("ink lab style", () => {
  it("wash uses dryWashRgb", () => {
    const fast = washRgb(2000, 0, 1);
    const slow = washRgb(0, 0, 1);
    const wet = dryWashRgb(INK_HEX, 1);
    expect(slow[0]).toBeCloseTo(wet.r, 0);
    expect(fast[0]).toBeGreaterThan(slow[0] - 1);
  });

  it("pooling grows the tip toward a halt radius", () => {
    const base = 8;
    let r = base;
    for (let i = 0; i < 40; i++) r = growTipRadius(base, r);
    expect(r).toBeGreaterThan(base);
    expect(r).toBeLessThanOrEqual(base * 1.7 + 1e-6);
  });

  it("hold pool swells the trail instead of a disc on a stick", () => {
    const rest = [
      { x: 0, y: 0, r: 8, rgb: [120, 120, 120] as [number, number, number] },
      { x: 12, y: 0, r: 8, rgb: [120, 120, 120] as [number, number, number] },
      { x: 24, y: 0, r: 8, rgb: [120, 120, 120] as [number, number, number] },
    ];
    const spine = rest.map((p) => ({ ...p, rgb: [...p.rgb] as [number, number, number] }));
    labSwellHoldPool(spine, rest, 10, 1, [20, 20, 20]);
    expect(spine[2]!.r).toBe(10);
    expect(spine[1]!.r).toBeGreaterThan(8);
    expect(spine[1]!.r).toBeLessThan(10);
    expect(spine[0]!.r).toBeLessThanOrEqual(spine[1]!.r);
    expect(spine[2]!.rgb![0]).toBe(20);
    expect(spine[1]!.rgb![0]).toBeLessThan(120);
  });

  it("toolbar width and colour change the live nib", () => {
    const thin = labPenDot(
      {
        color: "#112233",
        baseWidth: 2,
        overlayScale: 2,
        dpr: 2,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 0,
        speedBlotBlend: 0,
        speedFade: 0,
        boldness: 1,
      },
      0,
      0,
      2,
      0.5,
      0,
      0,
    );
    const fat = labPenDot(
      {
        color: "#ff0000",
        baseWidth: 20,
        overlayScale: 2,
        dpr: 2,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 0,
        speedBlotBlend: 0,
        speedFade: 0,
        boldness: 1,
      },
      0,
      0,
      2,
      0.5,
      0,
      0,
    );
    expect(fat.r).toBeGreaterThan(thin.r * 2);
    expect(fat.rgb[0]).toBeGreaterThan(200);
    expect(thin.rgb[0]).toBeLessThan(80);
    expect(thin.a).toBe(1);
    expect(fat.a).toBe(1);
  });

  it("does not shrink the nib when overlayScale is a zoom factor", () => {
    const shared = {
      color: "#1a1a1a",
      baseWidth: 2,
      dpr: 2,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
    };
    const atPad = labPenDot({ ...shared, overlayScale: 1 }, 0, 0, 2, 0.5, 0, 0);
    const atZoom = labPenDot({ ...shared, overlayScale: 8 }, 0, 0, 2, 0.5, 0, 0);
    expect(atZoom.r).toBeCloseTo(atPad.r, 5);
    expect(atPad.r).toBeGreaterThan(2.5 * 2);
  });

  it("does not bead the radius from speed-ink width gain", () => {
    const pen = {
      color: "#1a1a1a",
      baseWidth: 8,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 1,
      speedFade: 1,
      boldness: 3,
    };
    const still = labPenDot(pen, 0, 0, 1, 0.5, 0, 0);
    const flying = labPenDot(pen, 8000, 0, 1, 0.5, 400, 0);
    expect(still.a).toBe(1);
    expect(flying.a).toBe(1);
    expect(still.r / flying.r).toBeLessThan(3);
  });

  it("maps default slider width to pad size 1", () => {
    expect(labNibSizeFromUiWidth(2)).toBe(1);
    expect(labNibSizeFromUiWidth(20)).toBe(2.8);
  });

  it("pressure clip fattens a light press on the nib", () => {
    const base = {
      color: "#1a1a1a",
      baseWidth: 2,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureSensitive: true,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
    };
    const clipped = labPenDot({ ...base, pressureClip: 0.3 }, 0, 0, 1, 0.3, 0, 0);
    const unclipped = labPenDot({ ...base, pressureClip: 1 }, 0, 0, 1, 0.3, 0, 0);
    expect(clipped.r).toBeGreaterThan(unclipped.r);
    expect(labPressureAmt({ ...base, pressureClip: 0.3 }, 0.3)).toBeCloseTo(1);
  });

  it("hold grow off stays nib-sized", () => {
    expect(labHoldGrow(8, 10, 0)).toBe(8);
    expect(labHoldGrow(8, 8, 1)).toBeGreaterThan(8);
  });

  it("speed ink fattens a slow nib and fade washes a fast one", () => {
    const base = {
      color: "#1a1a1a",
      baseWidth: 8,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedBlotBlend: 0,
      boldness: 1,
    };
    const evenStill = labPenDot({ ...base, speedInk: 0, speedFade: 0 }, 0, 0, 1, 0.5, 0, 0);
    const evenFly = labPenDot({ ...base, speedInk: 0, speedFade: 0 }, 8000, 0, 1, 0.5, 0, 0);
    expect(evenStill.r).toBeCloseTo(evenFly.r, 5);
    const pacedStill = labPenDot({ ...base, speedInk: 1, speedFade: 0 }, 0, 0, 1, 0.5, 0, 0);
    const pacedFly = labPenDot({ ...base, speedInk: 1, speedFade: 0 }, 8000, 0, 1, 0.5, 0, 0);
    expect(pacedStill.r).toBeGreaterThan(pacedFly.r);
    const solidFly = labPenDot({ ...base, speedInk: 0, speedFade: 0 }, 8000, 0, 1, 0.5, 0, 0);
    const fadedFly = labPenDot({ ...base, speedInk: 0, speedFade: 1 }, 8000, 0, 1, 0.5, 0, 0);
    expect(fadedFly.rgb[0]).toBeGreaterThan(solidFly.rgb[0]);
    const blotSlow = labPenDot({ ...base, speedInk: 0, speedFade: 0, speedBlotBlend: 1 }, 0, 0, 1, 0.5, 0, 0);
    expect(blotSlow.rgb[0]).toBeLessThan(evenStill.rgb[0]);
  });

  it("preview spine uses paced capsules instead of one miter radius", () => {
    const pen = labPenFromToolbar({
      color: "#2244aa",
      uiWidth: 2,
      dpr: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speed: 1,
      fade: 1,
      blot: 1,
    });
    const even = labPreviewSpine(pen, [
      { x: 0, y: 0, pressure: 0.5, slowness: 0.5 },
      { x: 40, y: 0, pressure: 0.5, slowness: 0.5 },
      { x: 80, y: 0, pressure: 0.5, slowness: 0.5 },
    ], 1);
    expect(even[0]!.r).toBeCloseTo(even[1]!.r, 5);
    const spine = labPreviewSpine(pen, [
      { x: 0, y: 0, pressure: 0.5, slowness: 1 },
      { x: 40, y: 0, pressure: 0.5, slowness: 0.5 },
      { x: 80, y: 0, pressure: 0.5, slowness: 0 },
    ], 1);
    expect(spine.length).toBeGreaterThan(3);
    expect(spine[0]!.r).toBeGreaterThan(spine[spine.length - 1]!.r);
    expect(spine[spine.length - 1]!.rgb![0]).toBeGreaterThan(spine[0]!.rgb![0]);
    expect(labCssSpeedFromSlowness(0.5)).toBeCloseTo(1.2, 5);
  });

  it("preview blot swells slow peaks like a remeshed pool", () => {
    const pen = labPenFromToolbar({
      color: "#2244aa",
      uiWidth: 8,
      dpr: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speed: 0,
      fade: 0,
      blot: 1,
    });
    const spine = labPreviewSpine(pen, [
      { x: 0, y: 0, pressure: 0.5, slowness: 0.5 },
      { x: 24, y: 0, pressure: 0.5, slowness: 0.9 },
      { x: 48, y: 0, pressure: 0.5, slowness: 0.5 },
    ], 1);
    const peak = Math.max(...spine.map((p) => p.r));
    expect(peak).toBeGreaterThan(spine[0]!.r * 1.05);
  });

  it("capillary relaxes interior samples and is opt-in", () => {
    const jagged = [
      { x: 0, y: 0, r: 4 },
      { x: 10, y: 12, r: 9 },
      { x: 20, y: 0, r: 4 },
    ];
    const out = capillaryRelax(jagged, 8);
    expect(Math.abs(out[1]!.y)).toBeLessThan(12);
    expect(out[1]!.r).toBeLessThan(9);
    expect(out[0]).toEqual(jagged[0]);
  });
});
