import { afterEach, describe, expect, it, vi } from "vitest";

import {
  advanceInkPalette,
  inkPaletteNow,
  onInkPaletteChange,
  provideInkPaletteAdvance,
  provideInkPaletteRetreat,
  publishInkPalette,
  resetInkPaletteBridge,
  retreatInkPalette,
} from "./inkPaletteBridge";
import { currentInkPalette, type InkPaletteHistory } from "../util/inkPaletteHistory";

const palette = (...colors: string[]): InkPaletteHistory => ({ items: [colors], index: 0 });

afterEach(() => {
  resetInkPaletteBridge();
});

describe("inkPaletteBridge", () => {
  it("hands out a stable snapshot before a board has published", () => {
    // `useSyncExternalStore` compares by identity — a fresh seed each read
    // would re-render forever.
    expect(inkPaletteNow()).toBe(inkPaletteNow());
    expect(currentInkPalette(inkPaletteNow()).length).toBeGreaterThan(0);
  });

  it("gives readers the palette the board published", () => {
    publishInkPalette(palette("#111111", "#222222"));
    expect(currentInkPalette(inkPaletteNow())).toEqual(["#111111", "#222222"]);
  });

  it("tells subscribers when the wheel turns, and stops when they leave", () => {
    const seen = vi.fn();
    const off = onInkPaletteChange(seen);
    publishInkPalette(palette("#111111"));
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    publishInkPalette(palette("#222222"));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the same history is published again", () => {
    const history = palette("#111111");
    publishInkPalette(history);
    const seen = vi.fn();
    onInkPaletteChange(seen);
    publishInkPalette(history);
    expect(seen).not.toHaveBeenCalled();
  });

  it("runs the board's own forward cycle, not a second fetch path", () => {
    const cycle = vi.fn();
    provideInkPaletteAdvance(cycle);
    advanceInkPalette();
    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it("runs the board's backward cycle from the open hub", () => {
    const back = vi.fn();
    provideInkPaletteRetreat(back);
    retreatInkPalette();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("is a no-op with no board mounted", () => {
    expect(() => advanceInkPalette()).not.toThrow();
    expect(() => retreatInkPalette()).not.toThrow();
  });

  it("drops the wheel when the board unmounts", () => {
    publishInkPalette(palette("#111111"));
    const cycle = vi.fn();
    const back = vi.fn();
    provideInkPaletteAdvance(cycle);
    provideInkPaletteRetreat(back);
    resetInkPaletteBridge();
    advanceInkPalette();
    retreatInkPalette();
    expect(cycle).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(currentInkPalette(inkPaletteNow())).not.toEqual(["#111111"]);
  });

  it("does not let one pane's unmount wipe the other's wheel", () => {
    publishInkPalette(palette("#111111"), "local");
    publishInkPalette(palette("#222222"), "server");
    resetInkPaletteBridge("local");
    expect(currentInkPalette(inkPaletteNow("server"))).toEqual(["#222222"]);
    expect(currentInkPalette(inkPaletteNow("local"))).not.toEqual(["#111111"]);
  });
});
