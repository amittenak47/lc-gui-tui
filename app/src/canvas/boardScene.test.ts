import { describe, expect, it, vi } from "vitest";

import {
  CaptureUpdateAction,
  createBoardScene,
  getCommonBounds,
} from "./boardScene";

describe("createBoardScene", () => {
  it("stores camera without an Excalidraw canvas", () => {
    const api = createBoardScene();
    api.updateScene({
      appState: { scrollX: 10, scrollY: 20, zoom: { value: 1.5 } },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    const state = api.getAppState();
    expect(state.scrollX).toBe(10);
    expect(state.scrollY).toBe(20);
    expect((state.zoom as { value: number }).value).toBe(1.5);
  });

  it("skips onChange for camera-only updates", () => {
    const api = createBoardScene({
      elements: [{ id: "a", x: 0, y: 0, width: 10, height: 10 }],
    });
    const onChange = vi.fn();
    api.setOnChange?.(onChange);
    api.updateScene({
      appState: { scrollX: 4 },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    expect(onChange).not.toHaveBeenCalled();
    api.updateScene({
      elements: [{ id: "a", x: 1, y: 0, width: 10, height: 10 }],
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("notifies scroll listeners when the camera moves", () => {
    const api = createBoardScene();
    const scroll = vi.fn();
    api.onScrollChange?.(scroll);
    api.updateScene({ appState: { scrollY: 40, zoom: { value: 2 } } });
    expect(scroll).toHaveBeenCalledWith(0, 40, { value: 2 });
  });

  it("undoes an IMMEDIATELY scene write", () => {
    const api = createBoardScene({
      elements: [{ id: "a", x: 0, y: 0, width: 10, height: 10 }],
    });
    api.updateScene({
      elements: [{ id: "b", x: 4, y: 0, width: 10, height: 10 }],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    expect((api.getSceneElements()[0] as { id: string }).id).toBe("b");
    expect(api.history?.undo()).toBe(true);
    expect((api.getSceneElements()[0] as { id: string }).id).toBe("a");
    expect(api.history?.redo()).toBe(true);
    expect((api.getSceneElements()[0] as { id: string }).id).toBe("b");
  });

  it("does not record NEVER updates", () => {
    const api = createBoardScene({
      elements: [{ id: "a", x: 0, y: 0, width: 10, height: 10 }],
    });
    api.updateScene({
      elements: [{ id: "a", x: 8, y: 0, width: 10, height: 10 }],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    expect(api.history?.undo()).toBe(false);
  });
});

describe("getCommonBounds", () => {
  it("unions element boxes", () => {
    expect(
      getCommonBounds([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: 5, width: 10, height: 10 },
      ]),
    ).toEqual([0, 0, 30, 15]);
  });
});
