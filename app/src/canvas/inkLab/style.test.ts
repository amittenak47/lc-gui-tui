import { describe, expect, it } from "vitest";

import { dryWashRgb } from "../rasterInk";
import { applyPreviewCamera, capillaryRelax, growTipRadius, INK_HEX, labCssSpeedFromSlowness, labFadeVel, labHoldGrow, labNibSizeFromUiWidth, labPenDot, labPenFromToolbar, labPreviewSpine, labPressureAmt, labSwellHoldPool, PREVIEW_BAND_MORPH_MS, PREVIEW_BAND_ZOOM_MS, PREVIEW_STEP_MS, previewSizeBandIndex, previewTransitionMs, previewZoomEase, samplePreviewCamera, washRgb, wrapPreviewUiWidth } from "./style";

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
    expect(labNibSizeFromUiWidth(1)).toBeCloseTo(0.075);
    expect(labNibSizeFromUiWidth(6)).toBe(3);
    expect(labNibSizeFromUiWidth(32)).toBe(16);
    expect(labNibSizeFromUiWidth(64)).toBe(32);
    expect(labNibSizeFromUiWidth(32)).toBeGreaterThan(labNibSizeFromUiWidth(6));
    expect(labNibSizeFromUiWidth(64)).toBeGreaterThan(labNibSizeFromUiWidth(32));
  });

  it("keeps growing the live nib past slider 6", () => {
    const pen = (baseWidth: number) =>
      labPenDot(
        {
          color: "#1a1a1a",
          baseWidth,
          overlayScale: 1,
          dpr: 1,
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
        1,
        0.5,
        0,
        0,
      );
    expect(pen(1).r).toBeLessThan(0.85);
    expect(pen(1).r).toBeLessThan(pen(2).r * 0.2);
    expect(pen(32).r).toBeGreaterThan(pen(6).r * 2);
    expect(pen(64).r).toBeGreaterThan(pen(32).r);
  });

  it("pressure clip darkens a light press, not the nib width", () => {
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
    expect(clipped.r).toBeCloseTo(unclipped.r, 5);
    expect(clipped.rgb[0]).toBeLessThan(unclipped.rgb[0] - 8);
    expect(labPressureAmt({ ...base, pressureClip: 0.3 }, 0.3)).toBeCloseTo(1);
  });

  it("starburst maps stylus pressure onto dryness, not radius", () => {
    const base = {
      color: "#1a1a1a",
      baseWidth: 8,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
    };
    const off = labPenDot({ ...base, pressureSensitive: false }, 0, 0, 1, 0.2, 0, 0);
    const light = labPenDot({ ...base, pressureSensitive: true }, 0, 0, 1, 0.2, 0, 0);
    const firm = labPenDot({ ...base, pressureSensitive: true }, 0, 0, 1, 1, 0, 0);
    expect(light.r).toBeCloseTo(firm.r, 5);
    expect(off.r).toBeCloseTo(firm.r, 5);
    expect(light.rgb[0]).toBeGreaterThan(firm.rgb[0] + 8);
    expect(firm.rgb[0]).toBeCloseTo(off.rgb[0], 0);
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
    const ordinary = labPenDot({ ...base, speedInk: 0, speedFade: 1 }, 1200, 0, 1, 0.5, 0, 0);
    const stillWet = labPenDot({ ...base, speedInk: 0, speedFade: 1 }, 0, 0, 1, 0.5, 0, 0);
    expect(Math.abs(ordinary.rgb[0] - stillWet.rgb[0])).toBeLessThan(
      Math.abs(fadedFly.rgb[0] - stillWet.rgb[0]) * 0.55,
    );
    const blotSlow = labPenDot({ ...base, speedInk: 0, speedFade: 0, speedBlotBlend: 1 }, 0, 0, 1, 0.5, 0, 0);
    expect(blotSlow.rgb[0]).toBeCloseTo(evenStill.rgb[0], 0);
    const blotHold = labPenDot({ ...base, speedInk: 0, speedFade: 0, speedBlotBlend: 1 }, 0, 0, 1, 0.5, 0, 1);
    expect(blotHold.rgb[0]).toBeLessThan(evenStill.rgb[0]);
  });

  it("boosts hop velocity when the sample window is a whole rAF", () => {
    expect(labFadeVel(12, 4, 4).vx).toBeCloseTo(3000);
    expect(labFadeVel(12, 4, 4).vy).toBeCloseTo(1000);
    const capped = labFadeVel(12, 4, 24);
    expect(capped.vx).toBeCloseTo(1500);
    expect(capped.vy).toBeCloseTo(500);
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
    const evenPen = labPenFromToolbar({
      color: "#2244aa",
      uiWidth: 2,
      dpr: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speed: 1,
      fade: 1,
      blot: 0,
    });
    const even = labPreviewSpine(evenPen, [
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

  it("preview blot swells contact and lift, not slow writing", () => {
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
      { x: 120, y: 0, pressure: 0.5, slowness: 0.9 },
      { x: 240, y: 0, pressure: 0.5, slowness: 0.5 },
    ], 1);
    const mid = spine[Math.floor(spine.length / 2)]!;
    expect(spine[0]!.r).toBeGreaterThan(mid.r);
    expect(spine[spine.length - 1]!.r).toBeGreaterThan(mid.r);
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

  it("preview camera steps back every 8 sizes so 9 looks like 1 and 16 like 8", () => {
    expect(wrapPreviewUiWidth(1)).toBe(1);
    expect(wrapPreviewUiWidth(8)).toBe(8);
    expect(wrapPreviewUiWidth(9)).toBe(1);
    expect(wrapPreviewUiWidth(16)).toBe(8);
    expect(wrapPreviewUiWidth(32)).toBe(8);
    expect(wrapPreviewUiWidth(33)).toBe(1);
    expect(wrapPreviewUiWidth(64)).toBe(8);
    expect(labNibSizeFromUiWidth(64)).toBe(32);
    const penAt = (uiWidth: number) =>
      labPenFromToolbar({
        color: "#2244aa",
        uiWidth,
        dpr: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speed: 1,
        fade: 0,
        blot: 0,
      });
    const pts = [
      { x: 40, y: 44, pressure: 0.5, slowness: 0.5 },
      { x: 200, y: 44, pressure: 0.5, slowness: 0.5 },
      { x: 400, y: 44, pressure: 0.5, slowness: 0.5 },
    ];
    const rOf = (ui: number) =>
      labPreviewSpine(penAt(wrapPreviewUiWidth(ui)), pts, 1)[1]!.r;
    expect(rOf(9)).toBeCloseTo(rOf(1), 5);
    expect(rOf(16)).toBeCloseTo(rOf(8), 5);
    expect(rOf(8)).toBeGreaterThan(rOf(1));
  });

  it("preview camera bands 1–8, 9–16, 17–24 and eases through the jump", () => {
    expect(previewSizeBandIndex(1)).toBe(0);
    expect(previewSizeBandIndex(8)).toBe(0);
    expect(previewSizeBandIndex(9)).toBe(1);
    expect(previewSizeBandIndex(16)).toBe(1);
    expect(previewSizeBandIndex(17)).toBe(2);
    expect(previewZoomEase(0)).toBe(0);
    expect(previewZoomEase(1)).toBe(1);
    expect(previewZoomEase(0.5)).toBeCloseTo(0.5, 5);
    expect(previewZoomEase(0.25)).toBeLessThan(0.25);
    expect(previewZoomEase(0.75)).toBeGreaterThan(0.75);
  });

  it("eases each size step and zooms then morphs on a band cross", () => {
    expect(previewTransitionMs(3, 4)).toBe(PREVIEW_STEP_MS);
    expect(previewTransitionMs(8, 9)).toBe(PREVIEW_BAND_ZOOM_MS + PREVIEW_BAND_MORPH_MS);
    expect(previewTransitionMs(9, 8)).toBe(PREVIEW_BAND_ZOOM_MS + PREVIEW_BAND_MORPH_MS);
    const stepMid = samplePreviewCamera(3, 4, PREVIEW_STEP_MS / 2);
    expect(stepMid.pathScale).toBe(1);
    expect(stepMid.displayWidth).toBeGreaterThan(3);
    expect(stepMid.displayWidth).toBeLessThan(4);
    const zoomEnd = samplePreviewCamera(8, 9, PREVIEW_BAND_ZOOM_MS - 1);
    expect(zoomEnd.displayWidth).toBe(8);
    expect(zoomEnd.pathScale).toBeCloseTo(1 / 8, 5);
    expect(zoomEnd.radiusScale).toBeCloseTo(1 / 8, 5);
    const handoff = samplePreviewCamera(8, 9, PREVIEW_BAND_ZOOM_MS);
    expect(handoff.displayWidth).toBe(1);
    expect(handoff.pathScale).toBeCloseTo(1 / 8, 5);
    expect(handoff.radiusScale).toBe(1);
    const morphMid = samplePreviewCamera(
      8,
      9,
      PREVIEW_BAND_ZOOM_MS + PREVIEW_BAND_MORPH_MS / 2,
    );
    expect(morphMid.displayWidth).toBe(1);
    expect(morphMid.radiusScale).toBe(1);
    expect(morphMid.pathScale).toBeGreaterThan(1 / 8);
    expect(morphMid.pathScale).toBeLessThan(1);
    const done = samplePreviewCamera(8, 9, PREVIEW_BAND_ZOOM_MS + PREVIEW_BAND_MORPH_MS);
    expect(done.displayWidth).toBe(1);
    expect(done.pathScale).toBe(1);
    const downMorphEnd = samplePreviewCamera(9, 8, PREVIEW_BAND_MORPH_MS - 1);
    expect(downMorphEnd.displayWidth).toBe(1);
    expect(downMorphEnd.radiusScale).toBe(1);
    expect(downMorphEnd.pathScale).toBeGreaterThan(1 / 8);
    expect(downMorphEnd.pathScale).toBeLessThan(1);
    const downZoom = samplePreviewCamera(9, 8, PREVIEW_BAND_MORPH_MS);
    expect(downZoom.displayWidth).toBe(8);
    expect(downZoom.pathScale).toBeCloseTo(1 / 8, 5);
    expect(downZoom.radiusScale).toBeCloseTo(1 / 8, 5);
    const downDone = samplePreviewCamera(9, 8, PREVIEW_BAND_MORPH_MS + PREVIEW_BAND_ZOOM_MS);
    expect(downDone.displayWidth).toBe(8);
    expect(downDone.pathScale).toBe(1);
    expect(downDone.radiusScale).toBe(1);
    const upMorphMid = samplePreviewCamera(
      8,
      9,
      PREVIEW_BAND_ZOOM_MS + PREVIEW_BAND_MORPH_MS / 2,
    );
    const downMorphMid = samplePreviewCamera(9, 8, PREVIEW_BAND_MORPH_MS / 2);
    expect(downMorphMid.pathScale).toBeCloseTo(upMorphMid.pathScale, 5);
    expect(downMorphMid.displayWidth).toBe(upMorphMid.displayWidth);
    expect(downMorphMid.radiusScale).toBe(upMorphMid.radiusScale);
    const upZoomMid = samplePreviewCamera(8, 9, PREVIEW_BAND_ZOOM_MS / 2);
    const downZoomMid = samplePreviewCamera(
      9,
      8,
      PREVIEW_BAND_MORPH_MS + PREVIEW_BAND_ZOOM_MS / 2,
    );
    expect(downZoomMid.pathScale).toBeCloseTo(upZoomMid.pathScale, 5);
    expect(downZoomMid.radiusScale).toBeCloseTo(upZoomMid.radiusScale, 5);
    expect(downZoomMid.displayWidth).toBe(upZoomMid.displayWidth);
    const scaled = applyPreviewCamera(
      [
        { x: 0, y: 0, r: 8 },
        { x: 100, y: 0, r: 8 },
      ],
      50,
      0,
      zoomEnd,
    );
    expect(scaled[0]!.x).toBeCloseTo(50 + (0 - 50) * zoomEnd.pathScale, 5);
    expect(scaled[0]!.r).toBeCloseTo(8 * zoomEnd.radiusScale, 5);
  });
});
