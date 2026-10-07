import { expect, it, vi } from "vitest";
import { askBookConflict } from "./bookConflictUi";
import type { BookConflict } from "./bookSync";
import type { ConflictUiLifecycle } from "./conflictUiWait";

it("carries an attachment preference through a mixed record choice to atomic synchronization", async () => {
  const capture = { kind: "whiteboard", id: "book", metadata: { title: "Test" }, record: { id: "book", title: "Test", agent: [] }, pages: [] };
  const conflict = { capture, remote: { record: capture.record }, record: true, lifecycle: false, pages: [] } as unknown as BookConflict;
  const show = vi.fn(async () => ({ pick: "merged" as const, artifacts: "server" as const, ink: "local" as const }));
  const result = await askBookConflict(conflict, {} as ConflictUiLifecycle, show);
  expect(result).toMatchObject({ record: "merged", artifacts: "server", pages: [] });
});
