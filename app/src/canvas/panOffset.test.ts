import { describe, expect, it } from "vitest";

import { PAN_REBASE_FRACTION, panDelta } from "./panOffset";

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
