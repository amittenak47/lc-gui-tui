/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import {
  MIN_BAND_PX,
  bandFromLocalPoints,
  coversMostOfBox,
  coversViewportBox,
  finalizeMarquee,
  hitRectsUnder,
  isPageCoverRect,
  localRectCoversHost,
  scaleOf,
  tightClientRects,
  tightLocalRects,
  unionLocalRects,
  unionViewportBoxes,
  viewportToLocal,
} from "./docMarquee";

describe("docMarquee", () => {
  it("bandFromLocalPoints floors height in screen pixels", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 100 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 100,
        height: 200,
        right: 100,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;

    const band = bandFromLocalPoints(body, { x: 10, y: 10 }, { x: 40, y: 12 });
    expect(band.left).toBe(10);
    expect(band.top).toBe(10);
    expect(band.width).toBe(30);
    // |12-10|=2 local; floor is MIN_BAND_PX / scale (scale=1) → 14
    expect(band.height).toBe(MIN_BAND_PX / scaleOf(body));
  });

  it("viewportToLocal divides by camera scale", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 200 });
    body.getBoundingClientRect = () =>
      ({
        left: 50,
        top: 20,
        width: 100, // rendered half of layout → scale 0.5
        height: 80,
        right: 150,
        bottom: 100,
        x: 50,
        y: 20,
        toJSON() {},
      }) as DOMRect;

    const local = viewportToLocal(body, 50 + 50, 20 + 40);
    expect(local.x).toBeCloseTo(100);
    expect(local.y).toBeCloseTo(80);
  });

  it("unionLocalRects covers the outer box", () => {
    expect(unionLocalRects([])).toBeNull();
    expect(
      unionLocalRects([
        { left: 10, top: 20, width: 30, height: 10 },
        { left: 5, top: 40, width: 50, height: 8 },
      ]),
    ).toEqual({ left: 5, top: 20, width: 50, height: 28 });
  });

  it("finalizeMarquee returns hitRects for intersecting blocks", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 400 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 600,
        right: 400,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;

    const p = document.createElement("p");
    p.textContent = "hello paragraph";
    p.getBoundingClientRect = () =>
      ({
        left: 20,
        top: 40,
        width: 200,
        height: 24,
        right: 220,
        bottom: 64,
        x: 20,
        y: 40,
        toJSON() {},
      }) as DOMRect;
    body.append(p);
    document.body.append(body);

    // jsdom Range has no layout; textUnder only needs a zero box to skip.
    const rangeProto = Range.prototype as Range & {
      getBoundingClientRect: () => DOMRect;
    };
    const prev = rangeProto.getBoundingClientRect;
    rangeProto.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;

    try {
      const rect = { left: 10, top: 30, width: 220, height: 50 };
      const done = finalizeMarquee(body, rect, body, undefined);
      expect(done).not.toBeNull();
      expect(done!.hitRects.length).toBeGreaterThan(0);
      expect(done!.hitRects[0]).toMatchObject({
        left: 20,
        top: 40,
        width: 200,
        height: 24,
      });
      expect(done!.anchor.kind).toBe("region");
    } finally {
      rangeProto.getBoundingClientRect = prev;
    }
  });

  it("finalizeMarquee falls back to the marquee when nothing hits", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 400 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 600,
        right: 400,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    document.body.append(body);

    const rect = { left: 10, top: 30, width: 80, height: 40 };
    const done = finalizeMarquee(body, rect, body, undefined);
    expect(done).not.toBeNull();
    expect(done!.hitRects).toEqual([rect]);
  });

  it("hitRectsUnder skips nested hit targets in favour of the outer block", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 400 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 600,
        right: 400,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const figure = document.createElement("figure");
    const img = document.createElement("img");
    const box = {
      left: 0,
      top: 0,
      width: 100,
      height: 80,
      right: 100,
      bottom: 80,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect;
    figure.getBoundingClientRect = () => box;
    img.getBoundingClientRect = () => box;
    figure.append(img);
    body.append(figure);
    document.body.append(body);

    const hits = hitRectsUnder(body, body, { left: 0, top: 0, width: 120, height: 100 });
    expect(hits).toHaveLength(1);
  });

  it("hitRectsUnder prefers inner paragraphs over a web snapshot wrapper", () => {
    const body = document.createElement("div");
    body.className = "lc-md-ink-doc";
    Object.defineProperty(body, "offsetWidth", { value: 400 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 600,
        right: 400,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const wrap = document.createElement("div");
    wrap.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 200,
        right: 400,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const p = document.createElement("p");
    p.textContent = "quote";
    p.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        width: 200,
        height: 24,
        right: 210,
        bottom: 44,
        x: 10,
        y: 20,
        toJSON() {},
      }) as DOMRect;
    wrap.append(p);
    body.append(wrap);
    document.body.append(body);

    const hits = hitRectsUnder(body, body, { left: 0, top: 0, width: 400, height: 80 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ left: 10, top: 20, width: 200, height: 24 });
  });

  it("hitRectsUnder walks nested chrome divs to links when there are no article tags", () => {
    const body = document.createElement("div");
    body.className = "lc-md-ink-doc";
    Object.defineProperty(body, "offsetWidth", { value: 400 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 800,
        right: 400,
        bottom: 800,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const outer = document.createElement("div");
    outer.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 800,
        right: 400,
        bottom: 800,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const gmail = document.createElement("a");
    gmail.textContent = "Gmail";
    gmail.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 10,
        width: 60,
        height: 20,
        right: 70,
        bottom: 30,
        x: 10,
        y: 10,
        toJSON() {},
      }) as DOMRect;
    const images = document.createElement("a");
    images.textContent = "Images";
    images.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 40,
        width: 70,
        height: 20,
        right: 80,
        bottom: 60,
        x: 10,
        y: 40,
        toJSON() {},
      }) as DOMRect;
    outer.append(gmail, images);
    body.append(outer);
    document.body.append(body);

    const hits = hitRectsUnder(body, body, { left: 0, top: 0, width: 400, height: 80 });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ left: 10, top: 10, width: 60, height: 20 });
    expect(hits[1]).toEqual({ left: 10, top: 40, width: 70, height: 20 });
  });

  it("coversViewportBox treats a slot-sized rect as the host", () => {
    const host = { left: 0, top: 0, right: 400, bottom: 800 };
    expect(coversViewportBox({ left: 0, top: 0, right: 400, bottom: 800 }, host)).toBe(
      true,
    );
    expect(coversViewportBox({ left: 10, top: 40, right: 300, bottom: 64 }, host)).toBe(
      false,
    );
  });

  it("coversMostOfBox treats a paper-sized wash as covering a shorter slot", () => {
    const slot = { left: 0, top: 0, right: 400, bottom: 800 };
    expect(coversMostOfBox({ left: 0, top: 0, right: 400, bottom: 800 }, slot)).toBe(
      true,
    );
    expect(coversMostOfBox({ left: 10, top: 40, right: 300, bottom: 64 }, slot)).toBe(
      false,
    );
    expect(
      coversViewportBox({ left: 0, top: 0, right: 400, bottom: 800 }, {
        left: 0,
        top: 0,
        right: 400,
        bottom: 4000,
      }),
    ).toBe(false);
  });

  it("isPageCoverRect drops a slot-sized wash on a taller document host", () => {
    const slot = document.createElement("div");
    slot.className = "lc-page-content-slot";
    const slotBox = {
      left: 0,
      top: 0,
      width: 400,
      height: 800,
      right: 400,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect;
    slot.getBoundingClientRect = () => slotBox;
    const host = document.createElement("div");
    host.className = "lc-doc-selectable-body";
    Object.defineProperty(host, "offsetWidth", { value: 400 });
    host.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 4000,
        right: 400,
        bottom: 4000,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    slot.append(host);
    document.body.append(slot);
    const wash = { left: 0, top: 0, right: 400, bottom: 800 };
    expect(coversViewportBox(wash, host.getBoundingClientRect())).toBe(false);
    expect(isPageCoverRect(wash, host)).toBe(true);
    expect(isPageCoverRect({ left: 12, top: 40, right: 212, bottom: 64 }, host)).toBe(
      false,
    );
    expect(
      localRectCoversHost(host, { left: 0, top: 0, width: 400, height: 800 }),
    ).toBe(true);
    expect(
      localRectCoversHost(host, { left: 12, top: 40, width: 200, height: 24 }),
    ).toBe(false);
  });

  it("unionViewportBoxes unions tight line boxes", () => {
    expect(unionViewportBoxes([])).toBeNull();
    const box = unionViewportBoxes([
      { left: 10, top: 20, right: 40, bottom: 32 },
      { left: 10, top: 34, right: 80, bottom: 46 },
    ]);
    expect(box).not.toBeNull();
    expect(box!.left).toBe(10);
    expect(box!.top).toBe(20);
    expect(box!.width).toBe(70);
    expect(box!.height).toBe(26);
  });

  it("localRectCoversHost is true only for a body-sized band", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 400 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 800,
        right: 400,
        bottom: 800,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    expect(
      localRectCoversHost(body, { left: 0, top: 0, width: 400, height: 800 }),
    ).toBe(true);
    expect(
      localRectCoversHost(body, { left: 12, top: 40, width: 200, height: 24 }),
    ).toBe(false);
    expect(
      tightLocalRects(body, [
        { left: 0, top: 0, width: 400, height: 800 },
        { left: 12, top: 40, width: 200, height: 24 },
      ]),
    ).toEqual([{ left: 12, top: 40, width: 200, height: 24 }]);
  });

  it("hitRectsUnder skips a wrapper that covers the page", () => {
    const body = document.createElement("div");
    Object.defineProperty(body, "offsetWidth", { value: 400 });
    body.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 800,
        right: 400,
        bottom: 800,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const wrap = document.createElement("p");
    wrap.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 800,
        right: 400,
        bottom: 800,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    body.append(wrap);
    document.body.append(body);
    const hits = hitRectsUnder(body, body, { left: 0, top: 0, width: 400, height: 80 });
    expect(hits).toEqual([]);
  });

  it("tightClientRects falls back to the paragraph when getClientRects is the visible slot", () => {
    const slot = document.createElement("div");
    slot.className = "lc-page-content-slot";
    const slotBox = {
      left: 0,
      top: 0,
      width: 400,
      height: 800,
      right: 400,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect;
    slot.getBoundingClientRect = () => slotBox;
    const host = document.createElement("div");
    Object.defineProperty(host, "offsetWidth", { value: 400 });
    host.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 4000,
        right: 400,
        bottom: 4000,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const p = document.createElement("p");
    p.textContent = "hello world";
    p.getBoundingClientRect = () =>
      ({
        left: 12,
        top: 40,
        width: 200,
        height: 24,
        right: 212,
        bottom: 64,
        x: 12,
        y: 40,
        toJSON() {},
      }) as DOMRect;
    host.append(p);
    slot.append(host);
    document.body.append(slot);
    const range = document.createRange();
    range.selectNodeContents(p);
    const prev = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function getClientRects() {
      return [slotBox] as unknown as DOMRectList;
    };
    try {
      const rects = tightClientRects(range, host);
      expect(rects).toHaveLength(1);
      expect(rects[0].width).toBe(200);
      expect(rects[0].height).toBe(24);
    } finally {
      Range.prototype.getClientRects = prev;
    }
  });

  it("tightClientRects falls back to the paragraph when getClientRects is the page", () => {
    const host = document.createElement("div");
    Object.defineProperty(host, "offsetWidth", { value: 400 });
    const hostBox = {
      left: 0,
      top: 0,
      width: 400,
      height: 800,
      right: 400,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect;
    host.getBoundingClientRect = () => hostBox;
    const p = document.createElement("p");
    p.textContent = "hello world";
    p.getBoundingClientRect = () =>
      ({
        left: 12,
        top: 40,
        width: 200,
        height: 24,
        right: 212,
        bottom: 64,
        x: 12,
        y: 40,
        toJSON() {},
      }) as DOMRect;
    host.append(p);
    document.body.append(host);
    const range = document.createRange();
    range.selectNodeContents(p);
    const prev = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function getClientRects() {
      return [hostBox] as unknown as DOMRectList;
    };
    try {
      const rects = tightClientRects(range, host);
      expect(rects).toHaveLength(1);
      expect(rects[0].width).toBe(200);
      expect(rects[0].height).toBe(24);
    } finally {
      Range.prototype.getClientRects = prev;
    }
  });
});

describe("a wash over one page of many", () => {
  const box = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON() {},
    }) as DOMRect;

  /*
   * A PDF open on page 2 of forty: the selectable body is the whole book, and
   * one page is a sliver of it. A rect covering that page used to fill ~2.5% of
   * every box the cover test compared against, so it read as line-sized — and
   * then went wrong four ways at once, because four pieces of chrome ask this
   * question and each does something different with the answer.
   */
  function book() {
    const host = document.createElement("div");
    host.className = "lc-doc-selectable-body";
    Object.defineProperty(host, "offsetWidth", { value: 800 });
    host.getBoundingClientRect = () => box(0, 0, 800, 40000);
    const page = document.createElement("div");
    page.dataset.docScope = "page-2";
    page.getBoundingClientRect = () => box(0, 1000, 800, 1000);
    host.append(page);
    document.body.append(host);
    return { host, page };
  }

  it("counts the page itself as something a rect must not cover", () => {
    const { host } = book();
    expect(localRectCoversHost(host, { left: 0, top: 1000, width: 800, height: 1000 })).toBe(
      true,
    );
    expect(isPageCoverRect({ left: 0, top: 1000, right: 800, bottom: 2000 }, host)).toBe(
      true,
    );
  });

  it("leaves the line boxes on that page alone", () => {
    const { host } = book();
    expect(
      localRectCoversHost(host, { left: 96, top: 1240, width: 420, height: 22 }),
    ).toBe(false);
  });

  it("drops the wash and keeps the lines in one pass", () => {
    const { host } = book();
    const kept = tightLocalRects(host, [
      { left: 0, top: 1000, width: 800, height: 1000 },
      { left: 96, top: 1240, width: 420, height: 22 },
      { left: 96, top: 1266, width: 380, height: 22 },
    ]);
    expect(kept).toHaveLength(2);
    expect(kept.every((rect) => rect.height === 22)).toBe(true);
  });
});
