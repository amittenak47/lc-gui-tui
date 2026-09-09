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

  it("does not remesh ink while the board is still riding the pan", () => {
    const src = readFileSync(join(here, "WhiteboardInkLab.tsx"), "utf8");
    const present = src.slice(
      src.indexOf("const presentIfCameraMoved = useCallback"),
      src.indexOf("[applyPageWindow, readViews, rebuildAndReplay]"),
    );
    expect(present).toMatch(/canvasRef\.current\?\.style\.transform/);
    expect(src).toMatch(/if \(canvasRef\.current\?\.style\.transform\) return/);
    expect(present).toMatch(/instantReplayOnPageWindow\(\)/);
    expect(present).toMatch(/instantReplayOnFirstPresent\(\)/);
    expect(present).toMatch(/instantReplayOnCameraRebase\(\)/);
    expect(present).not.toMatch(/engineRef\.current\?\.paint\(\)/);
  });

  it("does not remesh ink when a tool pick ends a camera that was not moving", () => {
    const src = readFileSync(join(here, "WhiteboardInkLab.tsx"), "utf8");
    const board = readFileSync(join(here, "Board.tsx"), "utf8");
    const moving = src.slice(
      src.indexOf("setCameraMoving(moving) {"),
      src.indexOf("sizeToHostRef.current();"),
    );
    expect(moving).toMatch(/remeshOnCameraMovingEnd\(wasMoving\)/);
    expect(board).toMatch(
      /stopPanInertia\(\);[\s\S]{0,400}commitVisualScrollRef\.current\(\);[\s\S]{0,100}cancelCameraMotion\(\)/,
    );
  });

  it("applies a wheel wedge to the live store before setTool re-reads lastWedge", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    const apply = src.slice(
      src.indexOf("const applyInkWedge = useCallback"),
      src.indexOf("const applyTextModeToAppState"),
    );
    expect(apply).toMatch(/presetStoreRef\.current = next/);
    expect(apply.indexOf("presetStoreRef.current = next")).toBeLessThan(
      apply.indexOf("setPresetStore(next)"),
    );
  });

  it("commits the live camera before idle remesh", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    const idle = src.slice(
      src.indexOf("cameraIdleTeardownTimerRef.current = window.setTimeout"),
      src.indexOf("pulseCameraMotionRef.current = pulseCameraMotion"),
    );
    expect(idle.indexOf("commitVisualScrollRef.current()")).toBeGreaterThan(-1);
    expect(idle.indexOf("commitVisualScrollRef.current()")).toBeLessThan(
      idle.indexOf("setCameraMoving(false)"),
    );
  });

  it("drops the pan translate before a settle remesh", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    const commit = src.slice(
      src.indexOf("const commitVisualScroll = useCallback"),
      src.indexOf("applyVisualScrollNowRef.current = applyVisualScrollNow"),
    );
    expect(commit.indexOf("clearPanOffsetsRef.current()")).toBeGreaterThan(-1);
    expect(commit.indexOf("clearPanOffsetsRef.current()")).toBeLessThan(
      commit.indexOf("rasterInkRef.current?.syncCamera()"),
    );
    expect(commit).not.toMatch(/landPanOffset\(\(\) => \{[^}]*syncCamera/s);
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

  it("still translates while a bottom-of-flick remesh is in flight", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    const apply = src.slice(
      src.indexOf("const applyVisualScrollNow = useCallback"),
      src.indexOf("const flushVisualScroll = useCallback"),
    );
    const veto = apply.slice(apply.indexOf("if (delta.rebase"));
    expect(veto).toMatch(/setPagePanOffsetRef\.current\(rideDx, delta\.dy\)/);
  });

  it("does not remesh ink inside the keepY camera write", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    const at = src.indexOf("placeContentSlotAtRef.current(nextScrollX, nextScrollY, zoom);");
    expect(at).toBeGreaterThan(-1);
    const after = src.slice(at, at + 280);
    expect(after).not.toMatch(/syncCamera/);
  });

  it("does not left-align the notebook on every scroll after Recentre", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    const clamp = src.slice(
      src.indexOf("const clampPanScroll = useCallback"),
      src.indexOf("publishPdfFilmFromScrollRef.current"),
    );
    expect(clamp).toMatch(/liveBoardViewSize/);
    expect(clamp).toMatch(/\? "keep" : "center"/);
    expect(clamp).not.toMatch(/\? "start" : "center"/);
    const wheel = src.slice(
      src.indexOf("* The wheel reads the page. It is the only thing it does now."),
      src.indexOf("root.addEventListener(\"wheel\""),
    );
    expect(wheel).not.toMatch(/lockedScrollXRef.current = wheeled.scrollX/);
    expect(wheel).toMatch(/lockX \?\? wheeled.scrollX/);
  });

  it("stores both lined-paper pitches from the write camera so rules travel with the ink", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    expect(src).toMatch(/linedPitch:/);
    expect(src).toMatch(/linedPitchWide/);
    expect(src).toMatch(/linedPitchCollege/);
    expect(src).toMatch(/linedPitchStateFromAppState/);
    expect(src).toMatch(/linedPaperCssGap/);
    expect(src).toMatch(/ensureLinedPair/);
    expect(src).toMatch(/linedFirstRuleScene/);
    expect(src).toMatch(/drawPageCameraAfterViewportChange/);
    expect(src).not.toMatch(/capViewWidth:/);
    expect(src).not.toMatch(/linedPaperScenePitch\(next, zoom\)/);
  });

  it("width-fits a restored notebook to this window and pins the left of the writing", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    const restore = src.slice(
      src.indexOf("restoreView: (saved)"),
      src.indexOf("appendScratchPage:"),
    );
    expect(restore).toMatch(/saved\.scrollY/);
    expect(restore).toMatch(/runFit\(page, "keepY"\)/);
    expect(restore).toMatch(/userAdjustedCameraRef\.current = false/);
    expect(src).toMatch(/drawPageFitBox/);
    const refit = src.slice(
      src.indexOf("const refitToViewport = useCallback"),
      src.indexOf("const scheduleFitView"),
    );
    expect(refit.indexOf("isDrawPageRegion")).toBeLessThan(
      refit.indexOf("userAdjustedCameraRef.current"),
    );
  });

  it("does not remesh the notebook when flipping annotate and scroll", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    expect(src).toMatch(/inkNeedsAnnotateToggleReplay/);
    expect(src).toMatch(/annotateToolFlipRef/);
    expect(src).toMatch(/live\.width === prev\.w/);
    expect(src).not.toMatch(/enabled=\{interactive\}/);
    expect(src).toMatch(/alreadyPlaced/);
    expect(src).toMatch(/const syncLiveBox = useCallback/);
    expect(src).toMatch(/const rideDx = scrollModeRef.current \? 0 : delta.dx/);
  });

  it("does not ping-pong a sash drag through window.resize", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    const fit = src.slice(
      src.indexOf("const applyLiveBoxFit"),
      src.indexOf("const nudgeViewportFit"),
    );
    expect(fit).toMatch(/sashDragActive/);
    expect(fit).not.toMatch(/dispatchEvent\(new Event\("resize"\)\)/);
    expect(fit).toMatch(/remeshInk/);
    expect(src).toMatch(/scheduleLiveViewportFit/);
    expect(src).not.toMatch(/setTimeout\(kick, 50\)/);
  });

  it("recentres a notebook about the hole centre", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    expect(src).toMatch(/drawPageRecentreCamera/);
    expect(src).toMatch(/runFit\(null, "recentre"\)/);
    expect(src).toMatch(/linedOverlayViewport/);
  });

  it("defers pan on a selectable PDF so hold-to-footnote can arm", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    const down = src.slice(
      src.indexOf("const onSelectableDoc ="),
      src.indexOf("const deferred = onCodeDock"),
    );
    expect(down).toMatch(/lc-doc-selectable/);
    expect(down).not.toMatch(/!onPdfDoc/);
    expect(src).toMatch(
      /hold-to-marquee listener on `\.lc-doc-selectable` still has to fire/,
    );
  });
});

describe("WhiteboardInkLab", () => {
  it("does not unmount the pad when the board is parked", () => {
    const src = readFileSync(join(here, "WhiteboardInkLab.tsx"), "utf8");
    expect(src).not.toMatch(/if \(!enabled\) return null;/);
    expect(src).toMatch(/clientWidth < 8/);
    const boot = src.slice(
      src.indexOf("const sizeToHost = () => {"),
      src.indexOf("Nested scroll moves host-bound ink"),
    );
    expect(boot).not.toMatch(/if \(!enabled\) return;/);
    expect(boot).not.toMatch(/enabled,/);
  });

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
    expect(src).toMatch(/instantReplayOnCameraRebase\(\)/);
    expect(src).toMatch(/rebuildAndReplay\(false, instantReplayOnFirstPresent\(\)\)/);
    expect(src).toMatch(/bakeSpineOffThread/);
    const composite = readFileSync(join(here, "inkLab/engine.ts"), "utf8").slice(
      readFileSync(join(here, "inkLab/engine.ts"), "utf8").indexOf("const composite"),
      readFileSync(join(here, "inkLab/engine.ts"), "utf8").indexOf("type LiftState"),
    );
    expect(composite).not.toMatch(/clipBlitRect|liveClipRect/);
    expect(src).not.toMatch(/Math\.max\(1, painted\.marginY\)/);
    const tick = src.slice(src.indexOf("const onPaintFrame"), src.indexOf("const schedulePaint"));
    expect(tick.indexOf("keepLivePaintPump")).toBeGreaterThan(-1);
    expect(tick.indexOf("keepLivePaintPump")).toBeLessThan(tick.indexOf("engine.paint"));
    expect(tick.indexOf("engine.paint")).toBeLessThan(tick.indexOf("reportLoad"));
    const report = src.slice(src.indexOf("const reportLoad"), src.indexOf("const stopPaintPump"));
    expect(report).toMatch(/if \(live\) return/);
    expect(src).toMatch(/primeSnap\(\)/);
    expect(src).toMatch(/replayRafRef\.current != null/);
    expect(src).toMatch(/new EraseBakeJob/);
    expect(src).toMatch(/engine\.liftRaw/);
    expect(src).toMatch(/bakeSpineOffThread/);
    expect(src).toMatch(/if \(drawingRef\.current\) return/);
    const down = src.slice(src.indexOf("const onPointerDown"), src.indexOf("const onPointerMove"));
    expect(down).toMatch(/instantReplayOnPointerDown/);
    expect(down).not.toMatch(/presentCommitted\(null, true\)/);
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

describe("Workspace pane switch", () => {
  it("does not treat coming back as a window resize or a fresh open", () => {
    const src = readFileSync(join(here, "../Workspace.tsx"), "utf8");
    const settle = src.slice(
      src.indexOf("const returning = showing && !wasShowingRef.current"),
      src.indexOf("A parked save used to leave switchMotion"),
    );
    expect(settle).toMatch(/syncLiveBox/);
    expect(settle).not.toMatch(/boardRef\.current\?\.nudgeViewportFit/);
    expect(settle).not.toMatch(/dispatchEvent\(new Event\("resize"\)\)/);
  });

  it("holds notebook ink until the camera has fitted", () => {
    const src = readFileSync(join(here, "../Workspace.tsx"), "utf8");
    expect(src).toMatch(/paint: false/);
    expect(src).toMatch(/ingestInkPages\(shards, opts\)/);
    expect(src).toMatch(/primeInkSnap/);
    expect(src).toMatch(/await boardRef\.current\?\.primeInkSnap\(\)/);
    expect(src).not.toMatch(/^\s*boardRef\.current\?\.primeInkSnap\(\);/m);
    expect(src).not.toMatch(/^\s*handle\.primeInkSnap\(\);/m);
  });

  it("keeps the loading doodle through the check beat", () => {
    const src = readFileSync(join(here, "../Workspace.tsx"), "utf8");
    expect(src).not.toMatch(/!done && <LoadingDoodle/);
    const start = src.indexOf("function WorkspaceLoadStatus");
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, start + 900)).toMatch(/<LoadingDoodle themeId=\{themeId\} \/>/);
  });

  it("does not tear the PDF down when switching to the other pane", () => {
    const src = readFileSync(join(here, "../Workspace.tsx"), "utf8");
    expect(src).toMatch(/paused=\{Boolean\(hubConflictAsk\)\}/);
    expect(src).toMatch(/offscreen=\{!showing\}/);
    expect(src).not.toMatch(/paused=\{!showing/);
  });

  it("keeps the PDF film layout on the unfocused split half", () => {
    const src = readFileSync(join(here, "../Workspace.tsx"), "utf8");
    expect(src).toMatch(/active \|\| Boolean\(splitRole\)/);
    expect(src).toMatch(/fillThumbs=\{active\}/);
  });

  it("does not close the PDF film when swapping split halves", () => {
    const src = readFileSync(join(here, "../App.tsx"), "utf8");
    expect(src).toMatch(/if \(!sameSplit\) setPdfFilmOpen\(false\)/);
  });

  it("does not move canvas DOM nodes when focusing the other split half", () => {
    const src = readFileSync(join(here, "../App.tsx"), "utf8");
    expect(src).toMatch(/if \(!visibleTabIds\(state\)\.includes\(id\)\) promote\(id\)/);
  });

  it("keeps the PDF film layout on the unfocused split half", () => {
    const src = readFileSync(join(here, "../Workspace.tsx"), "utf8");
    expect(src).toMatch(/active \|\| Boolean\(splitRole\)/);
    expect(src).toMatch(/fillThumbs=\{active\}/);
  });
});

describe("reading pan compositor", () => {
  it("hides the PDF text layer while the camera is live, not the footnote slot", () => {
    const css = readFileSync(join(here, "../styles.css"), "utf8");
    expect(css).toMatch(/html\.lc-doc-camera-live \.lc-pdf-text\.textLayer/);
    expect(css).not.toMatch(/html\.lc-doc-camera-live \.lc-page-marks-slot/);
  });
});

describe("lined overlay vs ink", () => {
  it("sits under the ink pad so a rule cannot cut a stroke cap", () => {
    const css = readFileSync(join(here, "../styles.css"), "utf8");
    const overlay = css.slice(
      css.indexOf(".lc-board-lined-overlay {"),
      css.indexOf(".lc-agent-fold {"),
    );
    const host = css.slice(
      css.indexOf(".lc-board-ink-lab-host {"),
      css.indexOf(".lc-annotating-code .lc-board-ink-lab-host"),
    );
    const overlayZ = Number(/z-index:\s*(\d+)/.exec(overlay)?.[1]);
    const hostZ = Number(/z-index:\s*(\d+)/.exec(host)?.[1]);
    expect(overlayZ).toBeGreaterThan(0);
    expect(hostZ).toBeGreaterThan(overlayZ);
  });
});

describe("ink undo after a new stroke", () => {
  it("undo and redo present in one frame and drop every redo stack", () => {
    const src = readFileSync(join(here, "WhiteboardInkLab.tsx"), "utf8");
    const undoAt = src.indexOf("undo() {");
    const redoAt = src.indexOf("redo() {");
    const canAt = src.indexOf("canUndo() {");
    expect(undoAt).toBeGreaterThan(-1);
    expect(redoAt).toBeGreaterThan(undoAt);
    expect(canAt).toBeGreaterThan(redoAt);
    const undo = src.slice(undoAt, redoAt);
    expect(undo).toMatch(/presentCommitted\(null, true\)/);
    expect(undo).not.toMatch(/forgetPixelHistory/);
    const redo = src.slice(redoAt, canAt);
    expect(redo).toMatch(/presentCommitted\(null, true\)/);
    expect(redo).not.toMatch(/forgetPixelHistory/);
    expect(src).toMatch(/dropRedoStacks/);
    expect(src).toMatch(/instantReplayOnPointerDown/);
  });
});

describe("empty Redo must not freeze the pad", () => {
  it("does not dispatch a fake Ctrl+Z the same handler will catch", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    const undoBoard = src.slice(
      src.indexOf("const undoBoard = useCallback"),
      src.indexOf("const redoBoard = useCallback"),
    );
    const redoBoard = src.slice(
      src.indexOf("const redoBoard = useCallback"),
      src.indexOf("Empty Redo used to dispatch"),
    );
    expect(undoBoard).not.toMatch(/triggerUndo|dispatchEvent/);
    expect(redoBoard).not.toMatch(/triggerRedo|dispatchEvent/);
    const onKey = src.slice(
      src.indexOf("Empty Redo used to dispatch"),
      src.indexOf("window.addEventListener(\"keydown\", onKey, true)"),
    );
    expect(onKey).toMatch(/if \(!event\.isTrusted\) return/);
  });
});
