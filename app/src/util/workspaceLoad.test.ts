import { describe, expect, it } from "vitest";

import {
  isWorkspaceLoadBusy,
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

describe("workspaceLoadHomeLabel", () => {
  it("uses Home for pads, Problems for a corpus load", () => {
    expect(workspaceLoadHomeLabel("opening whiteboard…")).toBe(true);
    expect(workspaceLoadHomeLabel("opening document…")).toBe(true);
    expect(workspaceLoadHomeLabel("loading the workspace…")).toBe(false);
  });
});
