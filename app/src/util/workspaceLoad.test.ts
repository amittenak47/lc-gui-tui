import { describe, expect, it } from "vitest";

import {
  BOOT_EMPTY_READY_MS,
  BOOT_MAX_WAIT_MS,
  BOOT_MIN_SHOW_MS,
  bootOverlayMayFinish,
  isWorkspaceLoadBusy,
  loadChromeFate,
  mayClearParkedPreparing,
  workspaceLoadHomeLabel,
} from "./workspaceLoad";

describe("isWorkspaceLoadBusy", () => {
  it("matches workspace and pad opens", () => {
    expect(isWorkspaceLoadBusy("loading the workspace…")).toBe(true);
    expect(isWorkspaceLoadBusy("opening offline…")).toBe(true);
    expect(isWorkspaceLoadBusy("opening whiteboard…")).toBe(true);
    expect(isWorkspaceLoadBusy("opening document…")).toBe(true);
  });

  it("ignores coach and idle", () => {
    expect(isWorkspaceLoadBusy(null)).toBe(false);
    expect(isWorkspaceLoadBusy("asking…")).toBe(false);
    expect(isWorkspaceLoadBusy("running tests…")).toBe(false);
  });
});

describe("loadChromeFate", () => {
  it("finishes when this load is still current", () => {
    expect(loadChromeFate(2, 2, 2)).toBe("finish");
  });

  it("releases the overlay when gen moved and nothing else claimed it", () => {
    // Unmount / Strict Mode: currentGen bumped, inFlight still this load.
    expect(loadChromeFate(1, 2, 1)).toBe("abandon");
  });

  it("leaves the overlay when a newer load already owns it", () => {
    expect(loadChromeFate(1, 3, 3)).toBe("defer");
    expect(loadChromeFate(1, 2, null)).toBe("defer");
  });
});

describe("workspaceLoadHomeLabel", () => {
  it("uses Home for pads, Problems for a corpus load", () => {
    expect(workspaceLoadHomeLabel("opening whiteboard…")).toBe(true);
    expect(workspaceLoadHomeLabel("opening document…")).toBe(true);
    expect(workspaceLoadHomeLabel("loading the workspace…")).toBe(false);
  });
});

describe("mayClearParkedPreparing", () => {
  it("holds preparing for a relaunch restore, not only a user open", () => {
    expect(mayClearParkedPreparing(true)).toBe(false);
    expect(mayClearParkedPreparing(false)).toBe(true);
  });
});

describe("bootOverlayMayFinish", () => {
  it("does not finish during the minimum show", () => {
    expect(
      bootOverlayMayFinish({
        elapsedMs: BOOT_MIN_SHOW_MS - 1,
        loading: false,
        sawLoad: true,
        idleShell: true,
      }),
    ).toBe(false);
  });

  it("holds while a workspace is still loading", () => {
    expect(
      bootOverlayMayFinish({
        elapsedMs: 800,
        loading: true,
        sawLoad: true,
        idleShell: false,
      }),
    ).toBe(false);
  });

  it("finishes after a load has actually completed", () => {
    expect(
      bootOverlayMayFinish({
        elapsedMs: BOOT_MIN_SHOW_MS,
        loading: false,
        sawLoad: true,
        idleShell: false,
      }),
    ).toBe(true);
  });

  it("lets an idle Home finish after the empty-ready beat", () => {
    expect(
      bootOverlayMayFinish({
        elapsedMs: BOOT_EMPTY_READY_MS,
        loading: false,
        sawLoad: false,
        idleShell: true,
      }),
    ).toBe(true);
  });

  it("does not treat a pending whiteboard tab as idle Home", () => {
    expect(
      bootOverlayMayFinish({
        elapsedMs: BOOT_EMPTY_READY_MS,
        loading: false,
        sawLoad: false,
        idleShell: false,
      }),
    ).toBe(false);
    expect(
      bootOverlayMayFinish({
        elapsedMs: BOOT_MAX_WAIT_MS,
        loading: false,
        sawLoad: false,
        idleShell: false,
      }),
    ).toBe(true);
  });
});
