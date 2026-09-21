import { describe, expect, it, beforeEach } from "vitest";
import { isArtifactLocked, resetArtifactLocksForTests, setArtifactLocked } from "./artifactLocks";

const parent = { kind: "whiteboard" as const, id: "nb1" };

describe("artifactLocks", () => {
  beforeEach(() => {
    resetArtifactLocksForTests();
  });

  it("is a local visual lock, not a catalog field", () => {
    expect(isArtifactLocked(parent, "a1")).toBe(false);
    setArtifactLocked(parent, "a1", true);
    expect(isArtifactLocked(parent, "a1")).toBe(true);
    expect(isArtifactLocked({ kind: "whiteboard", id: "other" }, "a1")).toBe(false);
    setArtifactLocked(parent, "a1", false);
    expect(isArtifactLocked(parent, "a1")).toBe(false);
  });
});
