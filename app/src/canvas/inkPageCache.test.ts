import { describe, expect, it } from "vitest";

import { InkPageBook } from "./inkPageCache";
import { INK_LRU_RADIUS, SPANNING_PAGE_ID, type PageFrame } from "./inkPageIndex";
import { decodeInkOps } from "./inkCodec";
import { NO_PRESSURE, type InkDrawOp, type InkEraseOp } from "./rasterInk";

function frames(count: number): PageFrame[] {
  const out: PageFrame[] = [];
  let y = 0;
  for (let i = 1; i <= count; i += 1) {
    out.push({ pageId: i, minY: y, maxY: y + 100 });
    y += 118;
  }
  return out;
}

function stroke(y: number, extra: Partial<InkDrawOp> = {}): InkDrawOp {
  return {
    kind: "draw",
    color: "#111",
    baseWidth: 2,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: [
      { x: 10, y, pressure: NO_PRESSURE },
      { x: 20, y, pressure: NO_PRESSURE },
    ],
    ...extra,
  };
}

describe("InkPageBook", () => {
  it("keeps decoded ops only for the LRU window plus spanning", () => {
    const book = new InkPageBook();
    book.setFrames(frames(20));
    book.setVisiblePage(10);
    for (let page = 1; page <= 20; page += 1) {
      book.visiblePage = page;
      book.commit(stroke(page * 118 - 80));
    }
    book.setVisiblePage(10);
    const hotPages = [...book.hot.keys()].filter((id) => id !== SPANNING_PAGE_ID).sort((a, b) => a - b);
    expect(hotPages).toEqual(
      Array.from({ length: 1 + 2 * INK_LRU_RADIUS }, (_, i) => 10 - INK_LRU_RADIUS + i),
    );
    expect(book.opCount()).toBe(20);
    expect(book.paintOps().length).toBeLessThan(book.opCount());
    expect(book.assembleOps()).toHaveLength(20);
  });

  it("undoes the last stroke even after scrolling to another page", () => {
    const book = new InkPageBook();
    book.setFrames(frames(10));
    book.setVisiblePage(1);
    book.commit(stroke(40));
    book.setVisiblePage(10);
    const second = book.commit(stroke(10 * 118 - 80));
    expect(book.opCount()).toBe(2);
    expect(book.undoOnce()).toBe(true);
    expect(book.assembleOps().some((op) => op.id === second.id)).toBe(false);
    expect(book.assembleOps()).toHaveLength(1);
    expect(book.redoOnce()).toBe(true);
    expect(book.assembleOps()).toHaveLength(2);
  });

  it("bins a seam-crossing stroke to page 0 once", () => {
    const book = new InkPageBook();
    book.setFrames(frames(3));
    book.commit(
      stroke(90, {
        points: [
          { x: 10, y: 90, pressure: NO_PRESSURE },
          { x: 10, y: 130, pressure: NO_PRESSURE },
        ],
      }),
    );
    expect(book.hot.get(SPANNING_PAGE_ID)?.length ?? book.cold.get(SPANNING_PAGE_ID)).toBeTruthy();
    const spanning = book.hot.get(SPANNING_PAGE_ID) ?? decodeInkOps(book.cold.get(SPANNING_PAGE_ID)!);
    expect(spanning).toHaveLength(1);
    expect(book.hot.get(1) ?? []).toHaveLength(0);
    expect(book.hot.get(2) ?? []).toHaveLength(0);
  });

  it("does not snapshot the whole book on each commit", () => {
    const book = new InkPageBook();
    book.setFrames(frames(4));
    book.commit(stroke(20));
    book.commit(stroke(30));
    expect(book.undo).toHaveLength(2);
    expect(book.undo.every((entry) => entry.kind === "add")).toBe(true);
  });

  it("assembles encoded shards without decoding cold pages", () => {
    const book = new InkPageBook();
    book.setFrames(frames(12));
    book.setVisiblePage(1);
    for (let page = 1; page <= 12; page += 1) {
      book.commit(stroke(page * 118 - 80));
    }
    book.setVisiblePage(1);
    const encoded = book.assembleEncoded();
    expect(decodeInkOps(encoded)).toHaveLength(12);
    expect(book.hot.size).toBeLessThan(12);
  });

  it("marks dirty pages and clears them on flush", () => {
    const book = new InkPageBook();
    book.setFrames(frames(3));
    book.commit(stroke(20));
    expect(book.dirtyCount()).toBe(1);
    const dirty = book.takeDirtyEncoded();
    expect(dirty.size).toBe(1);
    book.markFlushed(dirty.keys());
    expect(book.dirtyCount()).toBe(0);
  });

  it("stroke-erase records removed ops for undo, not a full list snapshot", () => {
    const book = new InkPageBook();
    book.setFrames(frames(2));
    const a = book.commit(stroke(20));
    book.commit(stroke(200));
    const erase: InkEraseOp = {
      kind: "erase",
      radius: 20,
      points: [
        { x: 10, y: 20, pressure: NO_PRESSURE },
        { x: 12, y: 20, pressure: NO_PRESSURE },
      ],
    };
    expect(book.strokeErase(erase)).not.toBeNull();
    expect(book.assembleOps().some((op) => op.id === a.id)).toBe(false);
    expect(book.opCount()).toBe(1);
    book.undoOnce();
    expect(book.assembleOps().some((op) => op.id === a.id)).toBe(true);
  });
});
