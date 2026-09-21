import { describe, expect, it } from "vitest";
import { mergeProcessEvent, coalesceReasonListItems } from "./processEvents";
import type { CoachProcessEvent } from "../api/types";

const step = (detail: string, updateId = "reason-1-0"): CoachProcessEvent => ({
  kind: "stage", label: "reason", detail, updateId, ts: 10,
});

describe("streaming process updates", () => {
  it("replaces a growing step without changing its timestamp or neighbours", () => {
    const initial = [step("First"), step("Other", "reason-2-0")];
    const next = mergeProcessEvent(initial, { ...step("First step complete"), ts: 20 });
    expect(next).toEqual([step("First step complete"), initial[1]]);
    expect(initial[0]?.detail).toBe("First");
  });
  it("appends ordinary events and removes obsolete streamed steps", () => {
    const ordinary = { ...step("Reading"), updateId: undefined };
    expect(mergeProcessEvent([ordinary], ordinary)).toHaveLength(2);
    expect(mergeProcessEvent([step("First"), ordinary], step(""))).toEqual([ordinary]);
  });
});

describe("coalesceReasonListItems", () => {
  it("keeps numbered document points inside the thought that introduced them", () => {
    const intro: CoachProcessEvent = {
      kind: "stage", label: "reason", ts: 1,
      detail: "So the document describes:",
    };
    const items = [1, 2, 3, 4].map((n) => ({
      kind: "stage" as const, label: "reason", ts: n + 1,
      detail: `${n}. Point ${n}`,
    }));
    const merged = coalesceReasonListItems([intro, ...items, {
      kind: "stage", label: "prefetch", ts: 9, detail: "Looking up earlier pages",
    }]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.detail).toContain("1. Point 1");
    expect(merged[0]?.detail).toContain("4. Point 4");
    expect(merged[1]?.label).toBe("prefetch");
  });
});
