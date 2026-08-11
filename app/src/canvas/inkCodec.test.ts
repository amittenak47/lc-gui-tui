/**
 * A lossy encoder standing between someone and their handwriting.
 *
 * Two of these tests are not about compression at all — they pin sentinels that
 * mean something other than a number, and an encoding that flattens either one
 * changes how strokes are drawn without changing anything visible in a diff.
 */

import { describe, expect, it } from "vitest";

import {
  decodeInkOps,
  encodeInkOps,
  inkOpsFrom,
  reviveEncodedInk,
} from "./inkCodec";
import { NO_PRESSURE, type InkDrawOp, type InkEraseOp, type InkOp } from "./rasterInk";

function stroke(points: InkDrawOp["points"], extra: Partial<InkDrawOp> = {}): InkDrawOp {
  return {
    kind: "draw",
    color: "#1b1f24",
    baseWidth: 2,
    maxFullness: 0.8,
    pressureClip: 0.6,
    pressureSensitive: true,
    points,
    ...extra,
  };
}

/** A stamp chain the way the renderer lays one down: small, irregular steps. */
function stampChain(count: number): InkDrawOp {
  const points = [];
  let x = 640.1928100585938;
  let y = 312.4111328125;
  for (let i = 0; i < count; i += 1) {
    x += 1.1 + Math.sin(i) * 0.4;
    y += 0.9 + Math.cos(i * 0.7) * 0.5;
    points.push({
      x,
      y,
      pressure: 0.4235294117647059 + Math.sin(i * 0.3) * 0.2,
      slowness: 0.5137254901960784 + Math.cos(i * 0.2) * 0.3,
    });
  }
  return stroke(points);
}

function roundTrip(ops: InkOp[]): InkOp[] {
  return decodeInkOps(encodeInkOps(ops));
}

describe("encodeInkOps / decodeInkOps", () => {
  it("round-trips geometry within half a tenth of a scene unit", () => {
    const original = stampChain(60);
    const [back] = roundTrip([original]) as [InkDrawOp];
    expect(back.points).toHaveLength(60);
    for (let i = 0; i < 60; i += 1) {
      expect(back.points[i].x).toBeCloseTo(original.points[i].x, 1);
      expect(back.points[i].y).toBeCloseTo(original.points[i].y, 1);
      expect(Math.abs(back.points[i].x - original.points[i].x)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(back.points[i].y - original.points[i].y)).toBeLessThanOrEqual(0.05);
    }
  });

  it("does not let coordinate error accumulate along a long stroke", () => {
    // The failure this guards is a stroke that drifts: round each delta against
    // the true previous point and a thousand roundings in the same direction
    // walk the tail of the stroke away from where it was drawn.
    const original = stampChain(2000);
    const [back] = roundTrip([original]) as [InkDrawOp];
    const last = back.points[1999];
    expect(Math.abs(last.x - original.points[1999].x)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(last.y - original.points[1999].y)).toBeLessThanOrEqual(0.05);
  });

  it("round-trips pressure and slowness inside a byte's worth", () => {
    const original = stampChain(40);
    const [back] = roundTrip([original]) as [InkDrawOp];
    for (let i = 0; i < 40; i += 1) {
      expect(Math.abs(back.points[i].pressure - original.points[i].pressure)).toBeLessThan(
        1 / 254,
      );
      expect(
        Math.abs((back.points[i].slowness ?? 0) - (original.points[i].slowness ?? 0)),
      ).toBeLessThan(1 / 254);
    }
  });

  it("keeps NO_PRESSURE as exactly -1", () => {
    // Every mouse and touch point carries this. Quantised as a real value it
    // would come back as 0, which the renderer draws at a different alpha.
    const original = stroke([
      { x: 10, y: 10, pressure: NO_PRESSURE },
      { x: 12, y: 11, pressure: NO_PRESSURE },
    ]);
    const [back] = roundTrip([original]) as [InkDrawOp];
    expect(back.points[0].pressure).toBe(NO_PRESSURE);
    expect(back.points[1].pressure).toBe(NO_PRESSURE);
  });

  it("keeps an absent slowness absent", () => {
    // `undefined` means "speed ink was off", read downstream as neutral 0.5.
    // Materialising the key on every point silently changes stroke geometry.
    const original = stroke([
      { x: 10, y: 10, pressure: 0.5 },
      { x: 12, y: 11, pressure: 0.5 },
    ]);
    const [back] = roundTrip([original]) as [InkDrawOp];
    expect("slowness" in back.points[0]).toBe(false);
    expect(back.points[0].slowness).toBeUndefined();
  });

  it("keeps a slowness of zero as zero, not absent", () => {
    // The other half of the same distinction: 0 is "flat out", a real reading.
    const original = stroke([{ x: 10, y: 10, pressure: 0.5, slowness: 0 }]);
    const [back] = roundTrip([original]) as [InkDrawOp];
    expect(back.points[0].slowness).toBe(0);
    expect("slowness" in back.points[0]).toBe(true);
  });

  it("round-trips hostKey and scrollLeftAtDraw", () => {
    const original = stroke([{ x: 10, y: 10, pressure: 0.5 }], {
      hostKey: 2,
      scrollLeftAtDraw: 48,
    });
    const [back] = roundTrip([original]) as [InkDrawOp];
    expect(back.hostKey).toBe(2);
    expect(back.scrollLeftAtDraw).toBe(48);
  });

  it("carries the draw op's settings across", () => {
    const original = stroke([{ x: 1, y: 2, pressure: 0.5 }], {
      color: "#c0392b",
      baseWidth: 7,
      maxFullness: 0.42,
      pressureClip: 0.75,
      pressureSensitive: false,
      speedInk: 0.6,
    });
    const [back] = roundTrip([original]) as [InkDrawOp];
    expect(back.color).toBe("#c0392b");
    expect(back.baseWidth).toBe(7);
    expect(back.maxFullness).toBe(0.42);
    expect(back.pressureClip).toBe(0.75);
    expect(back.pressureSensitive).toBe(false);
    expect(back.speedInk).toBe(0.6);
  });

  it("carries speedBlotBlend across", () => {
    const original = stroke([{ x: 1, y: 2, pressure: 0.5 }], {
      speedInk: 0.6,
      speedBlotBlend: 0.8,
    });
    const [back] = roundTrip([original]) as [InkDrawOp];
    expect(back.speedBlotBlend).toBe(0.8);
  });

  it("leaves speedBlotBlend absent when the stroke had none", () => {
    const [back] = roundTrip([
      stroke([{ x: 1, y: 2, pressure: 0.5 }], { speedInk: 0.5 }),
    ]) as [InkDrawOp];
    expect(back.speedBlotBlend).toBeUndefined();
  });

  it("carries boldness across", () => {
    const original = stroke([{ x: 1, y: 2, pressure: 0.5 }], {
      boldness: 2.5,
    });
    const [back] = roundTrip([original]) as [InkDrawOp];
    expect(back.boldness).toBe(2.5);
  });

  it("leaves boldness absent when the stroke had none", () => {
    const [back] = roundTrip([stroke([{ x: 1, y: 2, pressure: 0.5 }])]) as [InkDrawOp];
    expect(back.boldness).toBeUndefined();
  });

  it("leaves speedInk absent when the stroke had none", () => {
    const [back] = roundTrip([stroke([{ x: 1, y: 2, pressure: 0.5 }])]) as [InkDrawOp];
    expect(back.speedInk).toBeUndefined();
  });

  it("remembers that a stroke was a highlighter one", () => {
    // Without this the marks come back as very wide, very opaque pen strokes
    // over the words they were meant to sit behind.
    const original = stroke([{ x: 1, y: 2, pressure: 0.5 }], { highlight: true });
    const [back] = roundTrip([original]) as [InkDrawOp];
    expect(back.highlight).toBe(true);
  });

  it("leaves the flag off a pen stroke, so old boards stay pen strokes", () => {
    const [back] = roundTrip([stroke([{ x: 1, y: 2, pressure: 0.5 }])]) as [InkDrawOp];
    expect(back.highlight).toBeUndefined();
  });

  it("round-trips an erase op's geometry and radius", () => {
    const original: InkEraseOp = {
      kind: "erase",
      radius: 24,
      points: [
        { x: 100.25, y: 200.5, pressure: NO_PRESSURE },
        { x: 101.05, y: 201.35, pressure: NO_PRESSURE },
      ],
    };
    const [back] = roundTrip([original]) as [InkEraseOp];
    expect(back.kind).toBe("erase");
    expect(back.radius).toBe(24);
    expect(back.points[0].x).toBeCloseTo(100.25, 1);
    expect(back.points[1].y).toBeCloseTo(201.35, 1);
  });

  it("does not give an erase point a slowness it never had", () => {
    // Erase ops are read for position and the op's radius, nothing else — see
    // `eraseStampsFrom`. Dropping the dead payload is the biggest single win
    // here, so the shape it comes back as is worth pinning.
    const [back] = roundTrip([
      {
        kind: "erase",
        radius: 8,
        points: [{ x: 5, y: 5, pressure: 0.7, slowness: 0.3 }],
      },
    ]) as [InkEraseOp];
    expect(back.points[0].slowness).toBeUndefined();
  });

  it("preserves op order and mixes kinds", () => {
    const ops: InkOp[] = [
      stroke([{ x: 0, y: 0, pressure: 0.5 }]),
      { kind: "erase", radius: 12, points: [{ x: 5, y: 5, pressure: NO_PRESSURE }] },
      stroke([{ x: 9, y: 9, pressure: 0.5 }], { color: "#0af" }),
    ];
    const back = roundTrip(ops);
    expect(back.map((op) => op.kind)).toEqual(["draw", "erase", "draw"]);
    expect((back[2] as InkDrawOp).color).toBe("#0af");
  });

  it("passes an over-range step through untouched instead of mangling it", () => {
    // Int16 in tenths tops out at ±3276.7 scene units between two points, which
    // stamp spacing makes unreachable. "Unreachable" is exactly the assumption
    // that turns into corrupted handwriting when a future tool moves the nib
    // differently, so the escape hatch is asserted rather than trusted.
    const far = stroke([
      { x: 0, y: 0, pressure: 0.5 },
      { x: 90_000, y: 0, pressure: 0.5 },
    ]);
    const encoded = encodeInkOps([far]);
    expect(encoded.ops).toHaveLength(0);
    expect(encoded.raw).toHaveLength(1);
    const [back] = decodeInkOps(encoded) as [InkDrawOp];
    expect(back.points[1].x).toBe(90_000);
  });

  it("keeps an encodable op encoded when another op overflows", () => {
    const encoded = encodeInkOps([
      stroke([{ x: 0, y: 0, pressure: 0.5 }]),
      stroke([
        { x: 0, y: 0, pressure: 0.5 },
        { x: 90_000, y: 0, pressure: 0.5 },
      ]),
    ]);
    expect(encoded.ops).toHaveLength(1);
    expect(encoded.raw).toHaveLength(1);
    expect(decodeInkOps(encoded)).toHaveLength(2);
  });

  it("survives an op with no points", () => {
    const encoded = encodeInkOps([stroke([])]);
    expect(decodeInkOps(encoded)).toHaveLength(1);
  });

  it("survives an empty op list", () => {
    expect(decodeInkOps(encodeInkOps([]))).toEqual([]);
  });

  it("costs well under ten bytes a point on a stamp chain", () => {
    // The measured baseline is ~107 bytes/point as JSON. Typed arrays give
    // Int16×2 + Uint8×2 = 6 bytes of payload; the budget below leaves room for
    // the per-op meta object amortised over the chain.
    const encoded = encodeInkOps([stampChain(600)]);
    const [record] = encoded.ops;
    const payload = record.xy.byteLength + (record.pr?.byteLength ?? 0) + (record.sl?.byteLength ?? 0);
    expect(payload / 600).toBeLessThan(7);
  });

  it("is far smaller than the old encoding once serialised", () => {
    const original = stampChain(60);
    const before = JSON.stringify(original).length;
    const after = JSON.stringify(encodeInkOps([original])).length;
    // Even through JSON — which cannot express a typed array compactly — the
    // rounding and the deltas alone are worth most of the saving.
    expect(after).toBeLessThan(before * 0.35);
  });
});

describe("inkOpsFrom", () => {
  it("reads an old blob's plain ink", () => {
    const ops = [stroke([{ x: 1, y: 1, pressure: 0.5 }])];
    expect(inkOpsFrom({ ink: ops })).toBe(ops);
  });

  it("reads a new blob's encoded ink", () => {
    const ops = [stampChain(20)];
    const back = inkOpsFrom({ inkC: encodeInkOps(ops) });
    expect(back).toHaveLength(1);
    expect((back[0] as InkDrawOp).points).toHaveLength(20);
  });

  it("gives both encodings the same geometry", () => {
    const ops = [stampChain(30)];
    const old = inkOpsFrom({ ink: ops }) as InkDrawOp[];
    const fresh = inkOpsFrom({ inkC: encodeInkOps(ops) }) as InkDrawOp[];
    for (let i = 0; i < 30; i += 1) {
      expect(fresh[0].points[i].x).toBeCloseTo(old[0].points[i].x, 1);
      expect(fresh[0].points[i].y).toBeCloseTo(old[0].points[i].y, 1);
    }
  });

  it("returns nothing rather than throwing on a board with no ink", () => {
    expect(inkOpsFrom({})).toEqual([]);
    expect(inkOpsFrom({ ink: undefined })).toEqual([]);
  });

  it("ignores an inkC that is not one of ours", () => {
    expect(inkOpsFrom({ inkC: { v: 9, ops: [] } })).toEqual([]);
    expect(inkOpsFrom({ inkC: "nonsense" })).toEqual([]);
  });

  it("falls back to plain ink when the encoded form is broken", () => {
    const ops = [stroke([{ x: 1, y: 1, pressure: 0.5 }])];
    // `ops` present but an entry missing its arrays entirely — a truncated or
    // hand-edited blob should cost the ink on one board, not the board.
    const broken = { v: 2 as const, ops: [null as never] };
    expect(inkOpsFrom({ ink: ops, inkC: broken })).toBe(ops);
  });
});

describe("reviveEncodedInk", () => {
  it("rebuilds typed arrays after a trip through JSON", () => {
    // `JSON.stringify(new Int16Array([1,2]))` is `{"0":1,"1":2}`. Left as that
    // object, indexing returns undefined and a page of handwriting decodes to
    // a single point.
    const original = stampChain(25);
    const wire = JSON.parse(JSON.stringify(encodeInkOps([original])));
    const revived = reviveEncodedInk(wire);
    expect(revived).not.toBeNull();
    expect(revived!.ops[0].xy).toBeInstanceOf(Int16Array);
    expect(revived!.ops[0].pr).toBeInstanceOf(Uint8Array);
    const [back] = decodeInkOps(revived!) as [InkDrawOp];
    expect(back.points).toHaveLength(25);
    expect(back.points[24].x).toBeCloseTo(original.points[24].x, 1);
  });

  it("carries raw overflow ops through the wire", () => {
    const wire = JSON.parse(
      JSON.stringify(
        encodeInkOps([
          stroke([
            { x: 0, y: 0, pressure: 0.5 },
            { x: 90_000, y: 0, pressure: 0.5 },
          ]),
        ]),
      ),
    );
    const back = decodeInkOps(reviveEncodedInk(wire)!) as [InkDrawOp];
    expect(back[0].points[1].x).toBe(90_000);
  });

  it("refuses anything that is not an encoded blob", () => {
    expect(reviveEncodedInk(null)).toBeNull();
    expect(reviveEncodedInk({ v: 1, ops: [] })).toBeNull();
    expect(reviveEncodedInk({ v: 2 })).toBeNull();
  });
});
