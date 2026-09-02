import { describe, it, expect } from "vitest";
import { inkSlowness, smoothSpeed, inkStrokeStyle, INK_SPEED_NEUTRAL_PX_MS } from "./rasterInk";

/** Widths a stroke paints when it rests for `pause` samples before setting off. */
function widths(pause: number) {
  const speeds = [
    ...Array(pause).fill(0),
    ...Array(14).fill(0).map((_, i) => Math.min(2, 0.2 + i * 0.7)),
  ];
  let s = INK_SPEED_NEUTRAL_PX_MS;
  return speeds.map((sample) => {
    s = smoothSpeed(s, sample);
    return inkStrokeStyle(10, 1, 0.6, 1, false, 0, inkSlowness(s), 0.6, false, 1, 0, 0.9).lineWidth;
  });
}

describe("speed ink does not balloon on a hesitation", () => {
  /*
   * Speed ink reads a slower nib as a wider mark, so the speed estimate falling
   * is the mark growing. Symmetric smoothing let a single stationary sample
   * carry the estimate most of the way down, so a pen resting an instant before
   * setting off painted a mark at full pooled width for one frame and then
   * collapsed back -- a flash at the start of a stroke.
   */
  it("takes several still samples to reach full width, not one", () => {
    const one = widths(1);
    const many = widths(20);
    const full = Math.max(...many);
    // One hesitant sample must not paint what a real hold paints.
    expect(Math.max(...one)).toBeLessThan(full * 0.8);
  });

  it("still reaches full width for an actual hold", () => {
    const many = widths(20);
    const settled = many[many.length - 1];
    expect(Math.max(...many) / settled).toBeGreaterThan(3);
  });

  it("rises monotonically while the pen is still, with no jump", () => {
    const w = widths(20).slice(0, 20);
    const span = Math.max(...w) - w[0];
    for (let i = 1; i < w.length; i++) {
      expect(w[i]).toBeGreaterThanOrEqual(w[i - 1] - 1e-9);
      // No single sample may carry a large share of the growth.
      expect(w[i] - w[i - 1]).toBeLessThan(span * 0.4);
    }
  });
});
