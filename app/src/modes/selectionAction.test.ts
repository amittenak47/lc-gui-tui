import { expect, it, vi } from "vitest";
import { createSelectionActionGate, selectionCaptureFailure } from "./selectionAction";

it("offers text-only continuation explicitly, without executing it during failure", async () => {
  const gate = createSelectionActionGate();
  const draft = vi.fn();
  const failed = selectionCaptureFailure("Capture timed out", "Selected words", gate.begin(), draft);
  expect(draft).not.toHaveBeenCalled();
  expect(failed.error).toBe("Capture timed out");
  expect(await failed.continueTextOnly?.()).toBe(true);
  expect(draft).toHaveBeenCalledTimes(1);
});

it("does not offer text-only continuation for a blank/scanned selection", () => {
  const failed = selectionCaptureFailure("No image", " \n", createSelectionActionGate().begin(), vi.fn());
  expect(failed.continueTextOnly).toBeUndefined();
});

it("invalidates old captures and fallback clicks when dismissed or replaced", () => {
  const gate = createSelectionActionGate();
  const draft = vi.fn();
  const old = gate.begin();
  const failed = selectionCaptureFailure("No image", "Words", old, draft);
  gate.reset();
  expect(old.isCurrent()).toBe(false);
  expect(failed.continueTextOnly?.()).toBe(false);
  const next = gate.begin();
  gate.begin();
  expect(next.isCurrent()).toBe(false);
  expect(draft).not.toHaveBeenCalled();
});

it("reports a changed source without accepting the fallback", () => {
  const failed = selectionCaptureFailure("No image", "Words", createSelectionActionGate().begin(), () => {
    throw new Error("The selected document or pane changed");
  });
  expect(failed.continueTextOnly?.()).toEqual({ ok: false, error: "The selected document or pane changed" });
});
