/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { intersectionArea, pickBestHit, pickLoopTarget, type LinkHit } from "./linkHitTest";
import { classifyStroke, spanOf, type StrokePoint } from "./linkStroke";

const hit = (
  id: string,
  kind: LinkHit["kind"],
  box: { left: number; top: number; width: number; height: number },
): LinkHit => ({ id, kind, label: id, ...box });

function ring(cx: number, cy: number, r: number, n = 24): StrokePoint[] {
  const points: StrokePoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI * 2 * i) / n;
    points.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return points;
}

describe("classifyStroke", () => {
  it("treats a closed ring as a loop", () => {
    expect(classifyStroke(ring(100, 100, 40))).toBe("loop");
  });

  it("treats a long open line as a connector", () => {
    expect(classifyStroke([{ x: 0, y: 10 }, { x: 200, y: 10 }])).toBe("connector");
  });

  it("treats a dense highlighter scribble as a scribble", () => {
    const points: StrokePoint[] = [];
    for (let i = 0; i < 40; i++) {
      points.push({ x: 40 + (i % 8) * 8, y: 40 + Math.floor(i / 8) * 10 });
    }
    expect(classifyStroke(points)).toBe("scribble");
  });

  it("treats a short wiggle as a tap", () => {
    expect(classifyStroke([{ x: 0, y: 0 }, { x: 4, y: 3 }])).toBe("tap");
  });

  it("spanOf still measures start to end", () => {
    expect(spanOf([{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 0, y: 0 }])).toBe(0);
  });
});

describe("pickBestHit", () => {
  const loop = { left: 0, top: 0, width: 200, height: 200 };

  it("prefers a mark over an image over a drawing", () => {
    const picked = pickBestHit(
      [
        hit("draw", "drawing", { left: 10, top: 10, width: 80, height: 80 }),
        hit("img", "image", { left: 20, top: 20, width: 60, height: 60 }),
        hit("fn", "mark", { left: 30, top: 30, width: 40, height: 40 }),
      ],
      loop,
    );
    expect(picked?.id).toBe("fn");
  });

  it("prefers the smaller image when two overlap", () => {
    const picked = pickBestHit(
      [
        hit("page", "image", { left: 0, top: 0, width: 200, height: 200 }),
        hit("fig", "image", { left: 40, top: 40, width: 50, height: 50 }),
      ],
      loop,
    );
    expect(picked?.id).toBe("fig");
  });

  it("falls back to a snippet when nothing overlaps enough", () => {
    const picked = pickBestHit(
      [hit("far", "mark", { left: 800, top: 800, width: 20, height: 20 })],
      loop,
    );
    expect(picked?.kind).toBe("snippet");
  });

  it("intersectionArea is zero for disjoint boxes", () => {
    expect(
      intersectionArea({ left: 0, top: 0, width: 10, height: 10 }, { left: 20, top: 20, width: 10, height: 10 }),
    ).toBe(0);
  });
});

describe("pickLoopTarget", () => {
  const loop = { left: 0, top: 0, width: 200, height: 200 };

  it("groups drawings whose boxes sit inside the loop", () => {
    const picked = pickLoopTarget(
      [
        hit("a", "drawing", { left: 20, top: 20, width: 40, height: 40 }),
        hit("b", "drawing", { left: 90, top: 90, width: 50, height: 40 }),
        hit("outside", "drawing", { left: 400, top: 400, width: 40, height: 40 }),
      ],
      loop,
    );
    expect(picked?.kind).toBe("snippet");
    expect(picked?.label).toBe("2 drawings");
    expect(picked?.id).toContain("drawing:a");
    expect(picked?.id).toContain("b");
    expect(picked?.width).toBe(120);
    expect(picked?.height).toBe(110);
  });

  it("does not group a lone drawing", () => {
    const picked = pickLoopTarget(
      [hit("a", "drawing", { left: 20, top: 20, width: 40, height: 40 })],
      loop,
    );
    expect(picked?.id).toBe("a");
    expect(picked?.kind).toBe("drawing");
  });

  it("keeps a mark when drawings share the loop", () => {
    const picked = pickLoopTarget(
      [
        hit("fn", "mark", { left: 30, top: 30, width: 24, height: 24 }),
        hit("a", "drawing", { left: 20, top: 20, width: 40, height: 40 }),
        hit("b", "drawing", { left: 90, top: 90, width: 50, height: 40 }),
      ],
      loop,
    );
    expect(picked?.id).toBe("fn");
  });
});
