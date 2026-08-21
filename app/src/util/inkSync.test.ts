import { describe, expect, it } from "vitest";

import { isInkConflict, remoteWins } from "./inkSync";
import {
  clearInkConflicts,
  inkConflictMessage,
  inkConflictsFor,
  noteInkConflicts,
  resetInkConflictsForTests,
} from "./inkConflicts";

describe("remoteWins", () => {
  it("takes a page this device has never seen", () => {
    expect(remoteWins(undefined, { updated_at: 1 })).toBe(true);
  });

  it("takes the newer copy", () => {
    expect(remoteWins({ updatedAt: 5 }, { updated_at: 9 })).toBe(true);
    expect(remoteWins({ updatedAt: 9 }, { updated_at: 5 })).toBe(false);
  });

  it("keeps what is already here on a tie", () => {
    // Two devices saving in the same millisecond. Taking the incoming copy
    // resolves by whichever pinged last, which is a coin toss, not a rule.
    expect(remoteWins({ updatedAt: 7 }, { updated_at: 7 })).toBe(false);
  });
});

describe("isInkConflict", () => {
  const since = 100;

  it("is not a conflict when only the other device drew", () => {
    // The ordinary case: this page has not been touched here since the last
    // sync, so taking the remote copy discards nothing.
    expect(isInkConflict({ updatedAt: 50 }, { updated_at: 150 }, since)).toBe(false);
  });

  it("is not a conflict when only this device drew", () => {
    expect(isInkConflict({ updatedAt: 150 }, { updated_at: 50 }, since)).toBe(false);
  });

  it("is a conflict when both drew since they last agreed", () => {
    expect(isInkConflict({ updatedAt: 150 }, { updated_at: 160 }, since)).toBe(true);
  });

  it("is not a conflict for a page this device has never seen", () => {
    expect(isInkConflict(undefined, { updated_at: 160 }, since)).toBe(false);
  });

  it("is not a conflict when the two stamps are the same page", () => {
    // Identical stamps are the same save arriving back, not two of them.
    expect(isInkConflict({ updatedAt: 160 }, { updated_at: 160 }, since)).toBe(false);
  });
});

describe("ink conflict banner", () => {
  it("names the page and where the losing copy went", () => {
    resetInkConflictsForTests();
    noteInkConflicts([
      { kind: "whiteboard", key: "w1", pageId: 3, localUpdatedAt: 2, remoteUpdatedAt: 3 },
    ]);
    const message = inkConflictMessage(inkConflictsFor("whiteboard", "w1"));
    expect(message).toContain("page 3");
    expect(message).toContain("snapshots");
    resetInkConflictsForTests();
  });

  it("lists several pages in order and does not repeat one", () => {
    resetInkConflictsForTests();
    const row = (pageId: number) => ({
      kind: "whiteboard" as const,
      key: "w1",
      pageId,
      localUpdatedAt: 2,
      remoteUpdatedAt: 3,
    });
    noteInkConflicts([row(5), row(2), row(5)]);
    expect(inkConflictsFor("whiteboard", "w1").map((c) => c.pageId)).toEqual([2, 5]);
    expect(inkConflictMessage(inkConflictsFor("whiteboard", "w1"))).toContain("pages 2 and 5");
    resetInkConflictsForTests();
  });

  it("keeps one pad's conflicts out of another's", () => {
    resetInkConflictsForTests();
    noteInkConflicts([
      { kind: "whiteboard", key: "w1", pageId: 1, localUpdatedAt: 2, remoteUpdatedAt: 3 },
      { kind: "annotate", key: "a1", pageId: 9, localUpdatedAt: 2, remoteUpdatedAt: 3 },
    ]);
    expect(inkConflictsFor("whiteboard", "w1")).toHaveLength(1);
    clearInkConflicts("whiteboard", "w1");
    expect(inkConflictsFor("whiteboard", "w1")).toHaveLength(0);
    expect(inkConflictsFor("annotate", "a1")).toHaveLength(1);
    resetInkConflictsForTests();
  });

  it("says nothing when nothing collided", () => {
    expect(inkConflictMessage([])).toBeNull();
  });
});
