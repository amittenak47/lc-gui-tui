import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
describe("tablet interaction wiring", () => {
  it("resets the active palette rotation at equal selector specificity", () => {
    const css = source("../styles.css");
    expect(css).toMatch(/\.lc-color-wheel \.lc-color-wheel-morph \.lc-morph-panel\.is-active\s*\{\s*transform: none/);
  });
  it("batches eraser presentation, while connecting each sampled segment", () => {
    const code = source("./WhiteboardInkLab.tsx");
    const stamp = code.slice(code.indexOf("const stampEraser ="), code.indexOf("let strokePaintView:"));
    expect(stamp).toContain("scheduleErasePaint()");
    expect(stamp).not.toContain("engine.paint()");
    expect(stamp).toContain("ctx.lineTo(s.x, s.y)");
  });
  it("arms library stamps without inserting a center-sized scene", () => {
    const code = source("./Board.tsx");
    const stamp = code.slice(code.indexOf("const stamp = useCallback"), code.indexOf("const insertImageFromDataURL"));
    expect(stamp).toContain("stampPlacementRef.current = factory");
    expect(stamp).not.toContain("api.updateScene");
    expect(code).toContain("if (!root.contains(target)) return;");
  });
  it("freezes scene-text viewport before focusing the soft keyboard", () => {
    const code = source("./SceneTextEditor.tsx");
    expect(code.indexOf("const releaseViewport = holdSceneTextViewport()")).toBeLessThan(code.indexOf("areaRef.current?.focus"));
    expect(code).toContain("releaseViewport()");
  });
});
