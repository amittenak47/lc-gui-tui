import { expect, it } from "vitest";
import { sectionPages, type TextBlock } from "./sectionPages";

const block = (top: number, bottom: number, lineHeight = 20): TextBlock => ({ top, bottom, lineHeight });

it("packs whole blocks and breaks a page before the one that does not fit", () => {
  const blocks = [block(0, 200), block(210, 450), block(460, 700), block(710, 900)];
  const frames = sectionPages(blocks, 500, 0, 900);
  expect(frames.map((f) => [f.minY, f.maxY])).toEqual([[0, 460], [460, 900]]);
  expect(frames.map((f) => f.pageId)).toEqual([1, 2]);
});

it("covers the whole column with no gaps or overlaps", () => {
  const blocks = Array.from({ length: 40 }, (_, i) => block(i * 110, i * 110 + 100));
  const frames = sectionPages(blocks, 480, 0, 4400);
  expect(frames[0]!.minY).toBe(0);
  expect(frames.at(-1)!.maxY).toBe(4400);
  for (let i = 1; i < frames.length; i += 1) expect(frames[i]!.minY).toBe(frames[i - 1]!.maxY);
  // Every break falls between blocks.
  for (const f of frames.slice(0, -1)) expect(blocks.some((b) => b.top === f.maxY)).toBe(true);
});

it("splits a block taller than a page between its lines", () => {
  const frames = sectionPages([block(0, 50), block(60, 1300, 24)], 500, 0, 1300);
  for (const f of frames.slice(0, -1)) {
    expect(f.maxY - f.minY).toBeLessThanOrEqual(500);
    // Breaks inside the listing land on its line grid.
    if (f.maxY > 60) expect((f.maxY - 60) % 24).toBe(0);
  }
  expect(frames.at(-1)!.maxY).toBe(1300);
});

it("does not leave a sliver page for a small block before a tall one", () => {
  const frames = sectionPages([block(0, 40), block(50, 900, 20)], 500, 0, 900);
  expect(frames[0]!.maxY - frames[0]!.minY).toBeGreaterThan(100);
});

it("answers nothing for an empty or unmeasured column", () => {
  expect(sectionPages([], 500, 0, 0)).toEqual([]);
  expect(sectionPages([block(0, 10)], 0, 0, 10)).toEqual([]);
});
