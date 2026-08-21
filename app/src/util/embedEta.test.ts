import { describe, expect, it } from "vitest";

import { ETA_WINDOW, etaLabel, etaMs, newEta, recordBatch } from "./embedEta";

describe("embedding estimate", () => {
  it("says nothing before the first batch", () => {
    // The honest answer, and the reason the ring sweeps instead of counting.
    expect(etaMs(newEta(), 100)).toBeNull();
    expect(etaLabel(null)).toBeNull();
  });

  it("is arithmetic once there is a rate", () => {
    const state = recordBatch(newEta(), { chunks: 10, ms: 5_000 });
    // 500ms a chunk, 20 left.
    expect(etaMs(state, 20)).toBe(10_000);
  });

  it("follows a machine that speeds up", () => {
    /*
     * A model becomes resident and the rate improves. An average over the whole
     * run would still be carrying the cold first batch; a window lets it go.
     */
    let state = newEta();
    state = recordBatch(state, { chunks: 1, ms: 30_000 });
    for (let i = 0; i < ETA_WINDOW; i += 1) {
      state = recordBatch(state, { chunks: 10, ms: 1_000 });
    }
    expect(state.samples).toHaveLength(ETA_WINDOW);
    expect(etaMs(state, 10)).toBe(1_000);
  });

  it("is zero when nothing is left", () => {
    const state = recordBatch(newEta(), { chunks: 10, ms: 1_000 });
    expect(etaMs(state, 0)).toBe(0);
  });

  it("ignores a batch that measured nothing", () => {
    const state = recordBatch(newEta(), { chunks: 0, ms: 1_000 });
    expect(state.samples).toHaveLength(0);
    expect(etaMs(state, 5)).toBeNull();
  });

  it("rounds to phrases a reader can use", () => {
    expect(etaLabel(20_000)).toBe("under a minute left");
    expect(etaLabel(90_000)).toBe("about 2 minutes left");
    expect(etaLabel(60_000)).toBe("about 1 minute left");
    expect(etaLabel(7_200_000)).toBe("about 2 hours left");
  });
});
