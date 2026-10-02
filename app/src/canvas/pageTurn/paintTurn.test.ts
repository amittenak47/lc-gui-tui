import { describe, expect, it } from "vitest";
import { flatSheet, paintTurn, underBlur } from "./paintTurn";

describe("flatSheet", () => {
  const frame = { layout: "sheet" as const, width: 400, height: 600, bottom: false };
  /** Where the flat sheet ends at the height nearest `y`. */
  const foldAt = (flat: { x: number; y: number }[], y: number) =>
    flat.slice(1, -1).reduce((best, p) => (Math.abs(p.y - y) < Math.abs(best.y - y) ? p : best)).x;

  it("folds a sheet held by its side top to bottom, leading where it is held", () => {
    const flat = flatSheet({ ...frame, corner: { x: 0, y: 270 }, restY: 270 });
    const held = foldAt(flat, 270);
    expect(held).toBeCloseTo(200, 0);
    // Above and below, the paper trails behind the hand.
    expect(foldAt(flat, 0)).toBeGreaterThan(held + 10);
    expect(foldAt(flat, 600)).toBeGreaterThan(held + 10);
  });

  it("keeps the fold straight at rest", () => {
    const flat = flatSheet({ ...frame, corner: { x: 400, y: 270 }, restY: 270 });
    expect(foldAt(flat, 0)).toBeCloseTo(400, 5);
    expect(foldAt(flat, 600)).toBeCloseTo(400, 5);
  });
});

describe("the page being turned to", () => {
  /** A 2D context that records which pictures were drawn, and at what alpha. */
  function recordingContext() {
    const drawn: Array<{ image: unknown; alpha: number }> = [];
    let alpha = 1;
    const target: Record<string, unknown> = {
      drawImage: (image: unknown) => drawn.push({ image, alpha }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      getTransform: () => ({ d: 1 }),
    };
    const ctx = new Proxy(target, {
      get: (t, key) => (key === "globalAlpha" ? alpha : key in t ? t[key as string] : () => {}),
      set: (t, key, value) => {
        if (key === "globalAlpha") alpha = value as number;
        else t[key as string] = value;
        return true;
      },
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
  }
  const to = { width: 400, height: 600 } as unknown as HTMLCanvasElement;
  const soft = { width: 80, height: 120 } as unknown as HTMLCanvasElement;
  const frame = (x: number) => ({
    layout: "sheet" as const, width: 400, height: 600, from: null, to, toBlur: soft,
    sourceWidth: 400, sourceHeight: 600, corner: { x, y: 600 }, bottom: true, paper: "#fff",
  });

  it("shows through its softened copy as the turn starts, and comes sharp as it lands", () => {
    const early = recordingContext();
    const p0 = paintTurn(early.ctx, frame(380));
    const softEarly = early.drawn.find((d) => d.image === soft);
    expect(p0).toBeLessThan(0.2);
    expect(softEarly?.alpha).toBeGreaterThan(0.7);
    expect(early.drawn.findIndex((d) => d.image === to)).toBeLessThan(early.drawn.findIndex((d) => d.image === soft));

    const late = recordingContext();
    const p1 = paintTurn(late.ctx, frame(-370));
    expect(p1).toBeGreaterThan(0.9);
    const softLate = late.drawn.find((d) => d.image === soft);
    expect(softLate === undefined || softLate.alpha < 0.05).toBe(true);
  });

  it("draws no softened copy when there is none", () => {
    const { ctx, drawn } = recordingContext();
    paintTurn(ctx, { ...frame(200), toBlur: null });
    expect(drawn.every((d) => d.image !== soft)).toBe(true);
    expect(underBlur(0)).toBe(1);
    expect(underBlur(1)).toBe(0);
  });
});
