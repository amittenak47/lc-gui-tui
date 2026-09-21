import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./HomeChooser.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("home chooser cards", () => {
  it("labels modes with a colored kicker and blurb, not a bold title", () => {
    expect(src).toContain('kicker: "Whiteboard"');
    expect(src).toContain('kicker: "Annotate"');
    expect(src).toContain('kicker: "Explore"');
    expect(src).not.toContain('kicker: "Scratch"');
    expect(src).not.toContain('kicker: "Reading"');
    expect(src).not.toContain('kicker: "Notes"');
    expect(src).not.toContain("lc-home-card-title");
    expect(src).not.toContain("{mode.title}");
    expect(css).toContain("align-items: center");
    expect(css).toContain("text-align: center");
    expect(css).not.toContain(".lc-home-card-title");
  });

  it("plays practice, whiteboard, and annotate icon scenes on hover", () => {
    expect(src).toContain('const HOVER_SCENES = new Set(["practice", "whiteboard", "annotate"])');
    expect(src).toContain('data-scene={hoverable ? scene : undefined}');
    expect(src).toContain("M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z");
    expect(src).toContain("lc-home-panel-a");
    expect(src).toContain("lc-home-panel-b");
    expect(css).toContain('data-scene="in"');
    expect(css).toContain('data-scene="out"');
    expect(css).toContain("lc-home-bra-in-l");
    expect(css).toContain("lc-home-nib-write");
    expect(css).toContain("lc-home-nib-place");
    expect(css).toContain("lc-home-panel-pop");
    expect(css).toContain("lc-home-page-refresh");
  });
});
