import { describe, expect, it } from "vitest";

import {
  INK_OVERDRAW_FRACTION,
  MAX_INK_CANVAS_DEVICE_PX,
  OVERDRAW_REBASE_HEADROOM,
  PAN_REBASE_FRACTION,
  overdrawMarginPx,
  overdrawnViewport,
  panDelta,
} from "./panOffset";

const VIEW = { width: 800, height: 600 };

describe("panDelta", () => {
  it("is zero when the live camera is the painted one", () => {
    const cam = { scrollX: 12, scrollY: -40, zoom: 1.5 };
    expect(panDelta(cam, cam, VIEW)).toEqual({ dx: 0, dy: 0, rebase: false });
  });

  it("scales the scroll delta by zoom, same sign as the content slot", () => {
    // The slot sits at (scene + scroll) * zoom, so scrolling +10 scene units
    // moves the page +20 screen px at 2x — the ink has to follow it, not it.
    const delta = panDelta(
      { scrollX: 10, scrollY: -5, zoom: 2 },
      { scrollX: 0, scrollY: 0, zoom: 2 },
      VIEW,
    );
    expect(delta).toEqual({ dx: 20, dy: -10, rebase: false });
  });

  it("rides right up to the rebase limit", () => {
    const limit = VIEW.height * PAN_REBASE_FRACTION;
    const delta = panDelta(
      { scrollX: 0, scrollY: limit, zoom: 1 },
      { scrollX: 0, scrollY: 0, zoom: 1 },
      VIEW,
    );
    expect(delta).toEqual({ dx: 0, dy: limit, rebase: false });
  });

  it("asks for a rebase past half a viewport, on either axis", () => {
    expect(
      panDelta({ scrollX: 0, scrollY: 301, zoom: 1 }, { scrollX: 0, scrollY: 0, zoom: 1 }, VIEW)
        .rebase,
    ).toBe(true);
    expect(
      panDelta({ scrollX: -401, scrollY: 0, zoom: 1 }, { scrollX: 0, scrollY: 0, zoom: 1 }, VIEW)
        .rebase,
    ).toBe(true);
  });

  it("honours per-axis limits over the fraction", () => {
    const headroom = VIEW.height * INK_OVERDRAW_FRACTION * OVERDRAW_REBASE_HEADROOM;
    expect(
      panDelta(
        { scrollX: 0, scrollY: headroom, zoom: 1 },
        { scrollX: 0, scrollY: 0, zoom: 1 },
        VIEW,
        PAN_REBASE_FRACTION,
        { y: headroom },
      ).rebase,
    ).toBe(false);
    expect(
      panDelta(
        { scrollX: 0, scrollY: headroom + 1, zoom: 1 },
        { scrollX: 0, scrollY: 0, zoom: 1 },
        VIEW,
        PAN_REBASE_FRACTION,
        { y: headroom },
      ).rebase,
    ).toBe(true);
  });

  it("scales the limit with zoom, because the delta does", () => {
    // 200 scene units is 400 screen px at 2x — past half of a 600px viewport.
    expect(
      panDelta({ scrollX: 0, scrollY: 200, zoom: 2 }, { scrollX: 0, scrollY: 0, zoom: 2 }, VIEW)
        .rebase,
    ).toBe(true);
    expect(
      panDelta({ scrollX: 0, scrollY: 200, zoom: 1 }, { scrollX: 0, scrollY: 0, zoom: 1 }, VIEW)
        .rebase,
    ).toBe(false);
  });

  it("refuses to translate across a zoom change", () => {
    const delta = panDelta(
      { scrollX: 0, scrollY: 0, zoom: 1.2 },
      { scrollX: 0, scrollY: 0, zoom: 1 },
      VIEW,
    );
    expect(delta).toEqual({ dx: 0, dy: 0, rebase: true });
  });

  it("treats a nonsense camera as a repaint, never as a translate", () => {
    const painted = { scrollX: 0, scrollY: 0, zoom: 1 };
    expect(panDelta({ scrollX: 0, scrollY: 0, zoom: 0 }, painted, VIEW).rebase).toBe(true);
    expect(panDelta({ scrollX: Number.NaN, scrollY: 0, zoom: 1 }, painted, VIEW).rebase).toBe(true);
    expect(
      panDelta({ scrollX: 0, scrollY: 0, zoom: 1 }, { ...painted, zoom: Number.NaN }, VIEW).rebase,
    ).toBe(true);
  });

  it("never divides by a zero viewport", () => {
    const delta = panDelta(
      { scrollX: 0, scrollY: 0.4, zoom: 1 },
      { scrollX: 0, scrollY: 0, zoom: 1 },
      { width: 0, height: 0 },
    );
    expect(delta.rebase).toBe(false);
  });
});

describe("overdrawMarginPx", () => {
  it("returns the fraction of CSS height at ordinary DPR", () => {
    expect(overdrawMarginPx(600, 1)).toBe(600 * INK_OVERDRAW_FRACTION);
    expect(overdrawMarginPx(600, 2)).toBe(600 * INK_OVERDRAW_FRACTION);
  });

  it("caps so total backing height stays under MAX_INK_CANVAS_DEVICE_PX", () => {
    const cssH = 2000;
    const dpr = 2;
    const margin = overdrawMarginPx(cssH, dpr);
    expect((cssH + 2 * margin) * dpr).toBeLessThanOrEqual(MAX_INK_CANVAS_DEVICE_PX + 1e-6);
  });

  it("returns 0 below the CSS floor (today's exact viewport)", () => {
    expect(overdrawMarginPx(32, 2)).toBe(0);
  });
});

describe("overdrawnViewport", () => {
  it("round-trips a visible pixel to the same scene point under the base view", () => {
    const base = { scrollX: 10, scrollY: -40, zoom: 2, width: 800, height: 600 };
    const margin = 150;
    const over = overdrawnViewport(base, margin);
    // Screen y in the visible band is canvasY - margin; scene from overdrawn
    // view at (x, y+margin) matches scene from base at (x, y).
    const screenX = 100;
    const screenY = 80;
    const sceneFromBase = {
      x: screenX / base.zoom - base.scrollX,
      y: screenY / base.zoom - base.scrollY,
    };
    const sceneFromOver = {
      x: screenX / over.zoom - over.scrollX,
      y: (screenY + margin) / over.zoom - over.scrollY,
    };
    expect(sceneFromOver.x).toBeCloseTo(sceneFromBase.x, 10);
    expect(sceneFromOver.y).toBeCloseTo(sceneFromBase.y, 10);
    expect(over.height).toBe(base.height + 2 * margin);
  });

  it("is a no-op when margin is zero", () => {
    const base = { scrollX: 1, scrollY: 2, zoom: 1.5, width: 10, height: 20 };
    expect(overdrawnViewport(base, 0)).toBe(base);
  });
});
