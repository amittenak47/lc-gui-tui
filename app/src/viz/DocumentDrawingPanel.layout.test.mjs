import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync(new URL("./DocumentDrawingPanel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("document drawing overlay", () => {
  it("stays a corner card until Enlarge drawing is pressed", () => {
    expect(panel).toContain('aria-label={enlargeLabel}');
    expect(panel).toContain('"Enlarge drawing"');
    expect(panel).toContain("is-maximized");
    expect(panel).toContain("{!compact ? (");
    expect(css).toContain(".lc-document-drawing-host");
    expect(css).toContain("overflow: hidden");
    const block = css.slice(css.indexOf("\n.lc-document-drawing-panel {"), css.indexOf(".lc-document-drawing-panel header"));
    expect(block).toContain("width: min(320px, calc(100% - 24px))");
    expect(block).not.toContain("inset:");
    expect(css).toContain(".lc-document-drawing-panel.is-dock-left");
    expect(css).toContain(".lc-document-drawing-panel.is-dock-right");
    expect(css).toContain(".lc-document-drawing-panel.is-stacked");
    expect(css).toContain(".lc-document-drawing-panel.is-parked");
    expect(css).toContain("transform: translateX(var(--lc-drawing-slide-x, -110%))");
    expect(panel).toContain("Drawings on this page");
    const enlarged = css.slice(css.indexOf(".lc-document-drawing-panel.is-maximized {"), css.indexOf(".lc-document-drawing-panel.is-maximized canvas"));
    expect(enlarged).toContain("width: min(560px, calc(100% - 24px))");
    expect(enlarged).not.toContain("inset:");
    expect(css).toContain(".lc-document-drawing-panel.is-maximized canvas");
  });
});
