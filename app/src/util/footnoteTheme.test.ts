import { describe, expect, it } from "vitest";

import {
  footnoteThemeVars,
  readableInk,
  readableInkOn,
  relativeLuminance,
} from "./footnoteTheme";

describe("footnoteThemeVars", () => {
  it("puts selected color in --lc-fn-color and rotates it to --lc-fn-p0", () => {
    const palette = ["#483838", "#42855b", "#90b77d", "#d2d79f"];
    const style = footnoteThemeVars("#90b77d", palette);
    expect(style["--lc-fn-color" as keyof typeof style]).toBe("#90b77d");
    expect(style["--lc-fn-p0" as keyof typeof style]).toBe("#90b77d");
    expect(style["--lc-fn-p1" as keyof typeof style]).toBe("#483838");
  });

  it("assigns light/deep from non-primary by luminance", () => {
    const palette = ["#111111", "#888888", "#eeeeee", "#ff0000"];
    const style = footnoteThemeVars("#ff0000", palette);
    expect(style["--lc-fn-deep" as keyof typeof style]).toBe("#111111");
    expect(style["--lc-fn-light" as keyof typeof style]).toBe("#eeeeee");
  });

  it("falls back to palette[0] when primary missing", () => {
    const palette = ["#0d9488", "#5eead4", "#99f6e4", "#ccfbf1"];
    const style = footnoteThemeVars(undefined, palette);
    expect(style["--lc-fn-color" as keyof typeof style]).toBe("#0d9488");
  });

  it("keeps label ink dark when the selected primary is a pastel", () => {
    const palette = ["#90b77d", "#b6d7a8", "#d9ead3", "#eef6eb"];
    const style = footnoteThemeVars("#b6d7a8", palette, "#f8fafc");
    expect(style["--lc-fn-color" as keyof typeof style]).toBe("#b6d7a8");
    const ink = String(style["--lc-fn-ink" as keyof typeof style]);
    expect(relativeLuminance(ink)).toBeLessThanOrEqual(0.38);
  });

  it("uses light label ink on a dark theme panel", () => {
    const palette = ["#90b77d", "#b6d7a8", "#d9ead3", "#eef6eb"];
    const style = footnoteThemeVars("#b6d7a8", palette, "#141416");
    const ink = String(style["--lc-fn-ink" as keyof typeof style]);
    expect(relativeLuminance(ink)).toBeGreaterThan(0.5);
  });

  it("tints nested chips from the palette, not the raw panel", () => {
    const palette = ["#90b77d", "#b6d7a8", "#d9ead3", "#eef6eb"];
    const style = footnoteThemeVars("#b6d7a8", palette, "#141416");
    expect(style["--lc-fn-chip" as keyof typeof style]).not.toBe("#141416");
    expect(style["--lc-fn-wash" as keyof typeof style]).not.toBe("#141416");
  });
});

describe("readableInk", () => {
  it("prefers a dark candidate over pastels", () => {
    expect(readableInk("#eeeeee", "#483838", "#90b77d")).toBe("#483838");
  });

  it("falls back when every candidate is too light", () => {
    expect(readableInk("#eef6eb", "#d9ead3", "#b6d7a8")).toBe("#1c1917");
  });
});

describe("readableInkOn", () => {
  it("picks light ink on a dark wash", () => {
    const ink = readableInkOn("#1a1a1c", ["#eef6eb", "#1c1917"]);
    expect(relativeLuminance(ink)).toBeGreaterThan(0.5);
  });
});

describe("relativeLuminance", () => {
  it("ranks white above black", () => {
    expect(relativeLuminance("#ffffff")).toBeGreaterThan(relativeLuminance("#000000"));
  });
});
