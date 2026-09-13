import { describe, expect, it } from "vitest";

import { WhiteboardInkLab } from "./WhiteboardInkLab";
import {
  inkCanvasPixelsChanged,
  inkCanvasCssMatches,
  idleRemeshAfterStrokeMs,
  remeshOnHostBoundLift,
  instantReplayOnBackingResize,
  instantReplayOnCameraRebase,
  instantReplayOnFirstPresent,
  instantReplayOnPageWindow,
  instantReplayOnPointerDown,
  finishReplayWhileDrawing,
  instantReplayOnUndo,
  keepLivePaintPump,
  remeshOnCameraMovingEnd,
  remeshOnNestedHostScroll,
  shiftSnapOnCameraRebase,
  skipCommittedReplay,
  skipHostBoundPresentWhileCameraBusy,
  skipReplayOnWheelAbort,
} from "./inkLab/liveHost";
import { shouldCompositeLive } from "./inkLab/displayHz";

describe("WhiteboardInkLab", () => {
  it("is the board pen surface, not RasterInkLayer", () => {
    expect(WhiteboardInkLab.displayName).toBe("WhiteboardInkLab");
  });

  it("does not replay the page while the pen is down", () => {
    expect(skipCommittedReplay(true, null)).toBe(true);
  });

  it("keeps the vsync pump running while the pen is down", () => {
    expect(keepLivePaintPump(true)).toBe(true);
  });

  it("skips empty composites and caps 90Hz presents at every other vsync", () => {
    expect(shouldCompositeLive(false, false, 0, 2)).toBe(false);
    expect(shouldCompositeLive(true, false, 1, 2)).toBe(false);
    expect(shouldCompositeLive(true, false, 0, 2)).toBe(true);
    expect(shouldCompositeLive(false, true, 0, 2)).toBe(true);
  });

  it("Match display uses stride 1 so every dirty vsync composites", () => {
    expect(shouldCompositeLive(true, false, 1, 1)).toBe(true);
  });

  it("does not remesh when only the overdraw park moved", () => {
    expect(inkCanvasPixelsChanged({ width: 1080, height: 2400 }, 1080, 2400)).toBe(
      false,
    );
  });

  it("does not replay the notebook on nib-wheel abort", () => {
    expect(skipReplayOnWheelAbort()).toBe(true);
  });

  it("keeps live resize atomic and loading resize sliced", () => {
    expect(instantReplayOnBackingResize()).toBe(true);
    expect(instantReplayOnBackingResize(true)).toBe(false);
  });

  it("does not instantly remesh when the page window hydrates", () => {
    expect(instantReplayOnPageWindow()).toBe(false);
  });

  it("does not remesh the notebook on an eraser tool pick", () => {
    expect(remeshOnCameraMovingEnd(false)).toBe(false);
  });

  it("does not remesh on letter lift; waits until the pen is idle", () => {
    expect(idleRemeshAfterStrokeMs()).toBe(400);
    expect(remeshOnHostBoundLift()).toBe(false);
  });

  it("restamps host-bound ink on nested scroll instead of remeshing", () => {
    expect(remeshOnNestedHostScroll()).toBe(false);
    expect(skipHostBoundPresentWhileCameraBusy()).toBe(false);
  });

  it("skips ink canvas CSS writes when the park already matches", () => {
    expect(
      inkCanvasCssMatches(
        { style: { width: "1px", height: "2px", top: "-3px", left: "0px" } },
        1,
        2,
        "-3px",
      ),
    ).toBe(true);
  });

  it("slices the first present after a restore", () => {
    expect(instantReplayOnFirstPresent()).toBe(false);
  });

  it("does not instantly remesh the notebook on pointer down", () => {
    expect(instantReplayOnPointerDown()).toBe(false);
  });

  it("does not blit a sliced remesh over a live stroke", () => {
    expect(finishReplayWhileDrawing()).toBe(false);
  });

  it("does not instantly remesh the notebook on undo without a pixel patch", () => {
    expect(instantReplayOnUndo()).toBe(false);
  });

  it("slides pan but keeps a real camera rebase atomic", () => {
    expect(shiftSnapOnCameraRebase()).toBe(true);
    expect(instantReplayOnCameraRebase()).toBe(true);
  });
});
