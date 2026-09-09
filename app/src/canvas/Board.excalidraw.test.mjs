import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("Board", () => {
  it("does not import or mount Excalidraw", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    expect(src).not.toMatch(/from\s+["']@excalidraw\/excalidraw["']/);
    expect(src).not.toMatch(/<Excalidraw\b/);
    expect(src).not.toMatch(/excalidraw\/index\.css/);
  });

  it("does not seed the live book from an empty inkC before shards land", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    expect(src).toMatch(/shouldSeedInkFromBlob/);
  });

  it("drops the pan translate before a mid-flick remesh", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    const rebase = src.slice(
      src.indexOf("const rebaseVisualScroll = useCallback"),
      src.indexOf("const commitVisualScroll = useCallback"),
    );
    expect(rebase.indexOf("clearPanOffsetsRef.current()")).toBeGreaterThan(-1);
    expect(rebase.indexOf("clearPanOffsetsRef.current()")).toBeLessThan(
      rebase.indexOf("rasterInkRef.current?.syncCamera()"),
    );
  });

  it("stores lined-paper pitch in scene units so rules travel with the ink", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    expect(src).toMatch(/linedPitch:/);
    expect(src).toMatch(/linedPitchFromAppState/);
    expect(src).toMatch(/linedPaperCssGap/);
    expect(src).toMatch(/linedPaperScenePitch/);
    expect(src).toMatch(/keepZoomKeepPanCameraAfterViewportChange/);
  });
});

describe("WhiteboardInkLab", () => {
  it("does not replay ink with the miter strip", () => {
    const src = readFileSync(join(here, "WhiteboardInkLab.tsx"), "utf8");
    expect(src).not.toMatch(/paintLabDrawOps/);
    expect(src).not.toMatch(/fillMiterStroke/);
    expect(src).not.toMatch(/inkLineWidth/);
  });

  it("maps toolbar colour, width, and hold grow onto the WebGL nib", () => {
    const src = readFileSync(join(here, "WhiteboardInkLab.tsx"), "utf8");
    expect(src).toMatch(/labPenFromToolbar/);
    expect(src).toMatch(/setPen\(/);
    expect(src).toMatch(/highlighterDrawOp/);
    expect(src).toMatch(/trimHighlightLiftHook/);
    expect(src).toMatch(/inkColorRef/);
    expect(src).toMatch(/strokeWidthRef/);
    expect(src).toMatch(/blotRef/);
    expect(src).toMatch(/speedInkRef/);
    expect(src).toMatch(/speedFadeRef/);
    expect(src).toMatch(/smoothingModeRef/);
    expect(src).toMatch(/InkLoadBar/);
    expect(src).toMatch(/perfOverlay/);
  });

  it("re-arms vsync before a budget present, from capture-phase pointer events", () => {
    const src = readFileSync(join(here, "WhiteboardInkLab.tsx"), "utf8");
    expect(src).toMatch(/keepLivePaintPump\(drawingRef\.current\)/);
    expect(src).not.toMatch(/drawingRef\.current && stats\.hold/);
    expect(src).toMatch(/addEventListener\("pointerdown", onPointerDown, true\)/);
    expect(src).toMatch(/addEventListener\("pointermove", onPointerMove, true\)/);
    expect(src).toMatch(/shouldCompositeLive/);
    expect(src).toMatch(/livePresentStride/);
    expect(src).toMatch(/matchDisplayRef/);
    expect(src).toMatch(/overdrawMarginPx/);
    expect(src).not.toMatch(/const marginY = 0/);
    expect(src).toMatch(/if \(drawingRef\.current \|\| cameraMovingRef\.current\) return/);
    expect(src).toMatch(/rebuildAndReplay\(false, true\)/);
    expect(src).not.toMatch(/Math\.max\(1, painted\.marginY\)/);
    const tick = src.slice(src.indexOf("const onPaintFrame"), src.indexOf("const schedulePaint"));
    expect(tick.indexOf("keepLivePaintPump")).toBeGreaterThan(-1);
    expect(tick.indexOf("keepLivePaintPump")).toBeLessThan(tick.indexOf("engine.paint"));
    expect(tick.indexOf("engine.paint")).toBeLessThan(tick.indexOf("reportLoad"));
    expect(src).toMatch(/shouldFlushLiveHud/);
  });
});

describe("InkPresetEditor", () => {
  it("paints the pen Preview with Ink lab capsules, not the miter strip", () => {
    const src = readFileSync(join(here, "InkPresetEditor.tsx"), "utf8");
    expect(src).toMatch(/labPreviewSpine/);
    expect(src).toMatch(/applyPreviewCamera/);
    expect(src).toMatch(/samplePreviewCamera/);
    expect(src).toMatch(/InkLabPreviewStrip/);
    expect(src).toMatch(/HighlightPreviewStrip/);
    expect(src).toMatch(/previewSizeBandIndex/);
    expect(src).not.toMatch(/fillMiterStroke/);
    expect(src).toMatch(/Speed ink/);
    expect(src).toMatch(/Ink fade/);
    expect(src).toMatch(/Ink blot/);
    expect(src).toMatch(/On Lift/);
    expect(src).toMatch(/While Writing/);
    expect(src).not.toMatch(/Performance overlay/);
    expect(src).not.toMatch(/kind !== ["']pen["'] && smoothPct/);
  });
});

describe("SettingsModal", () => {
  it("puts the performance overlay under Writing settings", () => {
    const src = readFileSync(join(here, "../components/SettingsModal.tsx"), "utf8");
    expect(src).toMatch(/id="writing"/);
    expect(src).toMatch(/Performance overlay/);
    expect(src).toMatch(/Performance bar/);
    expect(src).toMatch(/Display refresh/);
    expect(src).toMatch(/Match display/);
    expect(src).toMatch(/loadInkPerfOverlay/);
    expect(src).toMatch(/loadInkPerfBar/);
    expect(src).toMatch(/loadInkDisplayHz/);
    expect(src).toMatch(/loadInkMatchDisplay/);
  });
});
