import { describe, it, expect } from "vitest";
import { InkTileCache } from "./inkTiles";
import type { ScenePoint } from "./rasterInk";

function stub() {
  const ctx = new Proxy({ createLinearGradient: () => ({ addColorStop: () => {} }) } as Record<string, unknown>,
    { get(o, p: string) { return p in o ? o[p] : () => {}; }, set() { return true; } });
  return (width: number, height: number) =>
    ({ width, height, getContext: () => ctx }) as unknown as HTMLCanvasElement;
}

/** Every destination rect the cache blits a tile into. */
function blitRects(zoom: number, scrollX: number, scrollY: number) {
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  const dest = new Proxy(
    { drawImage: (...a: unknown[]) => {
        if (a.length === 9) rects.push({ x: a[5] as number, y: a[6] as number, w: a[7] as number, h: a[8] as number });
      } } as Record<string, unknown>,
    { get(o, p: string) { return p in o ? o[p] : () => {}; }, set() { return true; } },
  );
  const cache = new InkTileCache({ createCanvas: stub(), now: () => 0, schedule: () => 1, cancel: () => {} });
  const pts: ScenePoint[] = [];
  for (let i = 0; i < 200; i++) pts.push({ x: i * 12, y: i * 7, pressure: 0.6 });
  cache.setOps([{ kind: "draw", color: "#223344", baseWidth: 8, maxFullness: 1,
    pressureClip: 1, pressureSensitive: false, speedInk: 0, points: pts }]);
  cache.draw(dest as unknown as CanvasRenderingContext2D,
    { zoom, scrollX, scrollY, offsetLeft: 0, offsetTop: 0, width: 1400, height: 1000 }, 1);
  return rects;
}

describe("tiles meet without a seam", () => {
  // Awkward zooms and scrolls are exactly where fractional edges showed.
  for (const [zoom, sx, sy] of [[1, 0, 0], [1.137, 33.4, 71.9], [0.68, -12.5, 5.25], [2.4, 101.3, 0]] as const) {
    it(`lands on whole pixels at zoom ${zoom}, scroll ${sx},${sy}`, () => {
      const rects = blitRects(zoom, sx, sy);
      expect(rects.length).toBeGreaterThan(3);
      for (const r of rects) {
        expect(Number.isInteger(r.x)).toBe(true);
        expect(Number.isInteger(r.y)).toBe(true);
        expect(Number.isInteger(r.w)).toBe(true);
        expect(Number.isInteger(r.h)).toBe(true);
      }
      // Horizontally adjacent squares must share an edge exactly: no gap to
      // show the page through, no overlap to double the ink.
      const rows = new Map<number, Array<{ x: number; w: number }>>();
      for (const r of rects) {
        if (!rows.has(r.y)) rows.set(r.y, []);
        rows.get(r.y)!.push({ x: r.x, w: r.w });
      }
      let checked = 0;
      for (const row of rows.values()) {
        row.sort((a, b) => a.x - b.x);
        for (let i = 1; i < row.length; i++) {
          expect(row[i].x).toBe(row[i - 1].x + row[i - 1].w);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });
  }
});
