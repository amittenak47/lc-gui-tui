import { describe, expect, it } from "vitest";

import { countInkOpDuplicates, dedupeInkOps } from "./inkOpsDedupe";
import { encodeInkOps } from "./inkCodec";
import { NO_PRESSURE, type InkDrawOp } from "./rasterInk";
import { mergeEncodedPages } from "../util/inkSync";
import { decodeInkOps } from "./inkCodec";

const stroke = (y: number, id: number, color = "#111"): InkDrawOp => ({
  kind: "draw", color, baseWidth: 2, maxFullness: 1, pressureClip: 1, pressureSensitive: false, id, seq: id,
  points: [{ x: 10, y, pressure: NO_PRESSURE }, { x: 30, y: y + 0.25, pressure: NO_PRESSURE }],
});

describe("dedupeInkOps", () => {
  it("keeps the first of exact copies, whatever their ids", () => {
    const a = stroke(10, 1), b = stroke(40, 2);
    const ops = [a, b, { ...a, id: 7, seq: 7 }, { ...b, points: b.points.map((p) => ({ ...p })) }];
    expect(dedupeInkOps(ops)).toEqual([a, b]);
    expect(countInkOpDuplicates(ops)).toEqual({ ops: 2, points: 4 });
  });

  it("keeps strokes that differ by a point, a colour or a width", () => {
    const a = stroke(10, 1);
    const ops = [a, stroke(10.001, 2), stroke(10, 3, "#d92243"), { ...a, id: 4, baseWidth: 3 }];
    expect(dedupeInkOps(ops)).toHaveLength(4);
  });
});

describe("mergeEncodedPages", () => {
  it("does not double the strokes both sides share", () => {
    const shared = [stroke(10, 1), stroke(40, 2)];
    const local = new Map([[3, encodeInkOps([...shared, stroke(70, 3)])]]);
    const server = new Map([[3, encodeInkOps([...shared, stroke(90, 9)])]]);
    const merged = decodeInkOps(mergeEncodedPages(local, server).get(3)!);
    expect(merged).toHaveLength(4);
  });
});
