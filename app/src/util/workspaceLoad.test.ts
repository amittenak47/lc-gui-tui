import { describe, expect, it } from "vitest";

import {
  isWorkspaceLoadBusy,
  loadChromeFate,
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
