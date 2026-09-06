import { describe, expect, it } from "vitest";

import { allBaselineTapes } from "./tapes";
import { formatReplayHud, pfOutlineCount, replayTape } from "./replay";

describe("PF baseline tapes", () => {
  it("records p50/p95 vs N for PF and Speed Ink before any SDF work", () => {
    const tapes = allBaselineTapes();
    expect(tapes.map((t) => [t.name, t.samples.length])).toEqual([
      ["flick", 32],
      ["letter", 120],
      ["scribble", 512],
      ["hold", 240],
    ]);

    const rows = tapes.map((tape) => replayTape(tape.name, tape.samples));

    for (const row of rows) {
      // eslint-disable-next-line no-console
      console.log(formatReplayHud(row));
      expect(Number.isFinite(row.pf.p50)).toBe(true);
      expect(Number.isFinite(row.pf.p95)).toBe(true);
      expect(Number.isFinite(row.speedStamp.p95)).toBe(true);
      expect(Number.isFinite(row.speedBakeMs)).toBe(true);
      expect(row.pf.outlineN).toBeGreaterThan(4);
    }

    const flick = rows[0]!;
    const scribble = rows[2]!;
    const hold = rows[3]!;
    expect(scribble.pf.p95).toBeGreaterThan(flick.pf.p50);
    expect(hold.pf.holdMs).toBeGreaterThan(0);
    expect(pfOutlineCount(tapes[1]!.samples)).toBe(rows[1]!.pf.outlineN);
  });
});
