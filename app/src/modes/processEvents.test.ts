import { describe, expect, it } from "vitest";
import { mergeProcessEvent } from "./processEvents";
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
