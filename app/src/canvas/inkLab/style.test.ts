import { describe, expect, it } from "vitest";

import { dryWashRgb } from "../rasterInk";
import { capillaryRelax, growTipRadius, INK_HEX, labPenDot, washRgb } from "./style";

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
