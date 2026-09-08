import { describe, expect, it } from "vitest";

import {
  livePresentStride,
  medianMs,
  rafStallMs,
  resolveDisplayHz,
  shouldCompositeLive,
  snapDisplayHz,
  vsyncMsForHz,
} from "./displayHz";

describe("display Hz", () => {
  it("maps 60 / 90 / 120 / 240 to vsync milliseconds", () => {
    expect(vsyncMsForHz(60)).toBeCloseTo(1000 / 60, 5);
    expect(vsyncMsForHz(90)).toBeCloseTo(1000 / 90, 5);
    expect(vsyncMsForHz(120)).toBeCloseTo(1000 / 120, 5);
    expect(vsyncMsForHz(240)).toBeCloseTo(1000 / 240, 5);
  });

  it("snaps tablet 11ms gaps to 90Hz, not 60", () => {
    expect(snapDisplayHz(11)).toBe(90);
    expect(snapDisplayHz(11.1)).toBe(90);
    expect(snapDisplayHz(16.7)).toBe(60);
    expect(snapDisplayHz(8.3)).toBe(120);
    expect(snapDisplayHz(4.2)).toBe(240);
  });

  it("snaps a real 4.2ms gap to 240Hz", () => {
    expect(snapDisplayHz(4.2)).toBe(240);
  });

  it("lets Auto follow the median so a 5ms first callback cannot pin 240Hz", () => {
    expect(medianMs([5.7, 11.1, 11.0, 11.2])).toBeCloseTo(11.1, 1);
    expect(snapDisplayHz(medianMs([5.7, 11.1, 11.0, 11.2]))).toBe(90);
  });

  it("lets Auto follow the measurement and a manual pref win", () => {
    expect(resolveDisplayHz("auto", 11)).toBe(90);
    expect(resolveDisplayHz(60, 11)).toBe(60);
    expect(resolveDisplayHz(90, 16.7)).toBe(90);
  });

  it("caps live presents at 60fps on 90Hz+", () => {
    expect(livePresentStride(60)).toBe(1);
    expect(livePresentStride(90)).toBe(2);
    expect(livePresentStride(120)).toBe(2);
    expect(livePresentStride(240)).toBe(4);
  });

  it("skips empty ticks and respects the present stride", () => {
    expect(shouldCompositeLive(false, false, 0, 2)).toBe(false);
    expect(shouldCompositeLive(true, false, 0, 2)).toBe(true);
    expect(shouldCompositeLive(true, false, 1, 2)).toBe(false);
    expect(shouldCompositeLive(true, false, 2, 2)).toBe(true);
    expect(shouldCompositeLive(false, true, 0, 2)).toBe(true);
    expect(shouldCompositeLive(true, false, 3, 1)).toBe(true);
  });

  it("treats one skipped 90Hz beat as inside the stall window", () => {
    const vs = vsyncMsForHz(90);
    expect(22).toBeLessThan(rafStallMs(vs));
    expect(40).toBeGreaterThan(rafStallMs(vs));
  });
});
