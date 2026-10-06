/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RetainedCopies } from "./RetainedCopies";

const mocks = vi.hoisted(() => ({
  restore: vi.fn(async () => ({ kind: "annotate", id: "removed" })),
  snapshot: vi.fn(async (_kind: string, _key: string, _tier: string, snapshotId?: string) => ({ snapshotId, artifactBundle: { retained: true } })),
  restoreSnapshot: vi.fn(async () => {}),
  exported: vi.fn(async () => ({ original: new Uint8Array([1, 2]).buffer })),
}));
vi.mock("../util/syncRecovery", () => ({
  listRecoveryCopies: async () => [{ id: "recovery", type: "record", bookId: "removed", record: { meta: { name: "Removed parent" } } }],
  exportRecoveryCopy: mocks.exported,
}));
vi.mock("../util/padSnapshotStore", () => ({
  listAllPadSnapshots: async () => ["first", "second"].map(snapshotId => ({ kind: "annotate", key: "removed", tier: "7d", writtenAt: 1, name: snapshotId, snapshotId })),
  getPadSnapshot: mocks.snapshot,
}));
vi.mock("../util/recoveryRestore", () => ({ restoreRetainedRecord: mocks.restore, recoveryExportValue: async (value: unknown) => value }));
vi.mock("../util/artifactSnapshotRestore", () => ({ restorePadSnapshotLocally: mocks.restoreSnapshot }));
let root: Root;
let host: HTMLDivElement;
const refreshed = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks(); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:retained"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<RetainedCopies kind="annotate" onRestored={refreshed} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
it("offers a removed parent for explicit local restoration while preserving its export path", async () => {
  const row = [...host.querySelectorAll<HTMLDivElement>(".lc-scratch-load-entry")].find(row => row.textContent?.includes("Removed parent"))!;
  await click(row.querySelectorAll("button")[0]!); expect(mocks.exported).toHaveBeenCalledWith("recovery");
  await click(row.querySelectorAll("button")[1]!); expect(mocks.restore).not.toHaveBeenCalled();
  await click(row.querySelectorAll("button")[1]!); expect(mocks.restore).toHaveBeenCalledWith("recovery");
  expect(refreshed).toHaveBeenCalledOnce(); expect(row.querySelectorAll("button")[0]!.textContent).toBe("Export copy");
});
it("reads and restores the selected immutable same-tier snapshot with its dependency bundle", async () => {
  const row = [...host.querySelectorAll<HTMLDivElement>(".lc-scratch-load-entry")].find(row => row.querySelector("strong")?.textContent === "second")!;
  await click(row.querySelectorAll("button")[0]!);
  expect(mocks.snapshot).toHaveBeenLastCalledWith("annotate", "removed", "7d", "second");
  await click(row.querySelectorAll("button")[1]!); await click(row.querySelectorAll("button")[1]!);
  expect(mocks.restoreSnapshot).toHaveBeenCalledWith({ kind: "annotate", id: "removed" }, { snapshotId: "second", artifactBundle: { retained: true } }, { retained: true });
  expect(host.querySelectorAll(".lc-scratch-load-entry")).toHaveLength(3);
});
it("keeps retained entries reachable and displays a refused restoration", async () => {
  mocks.restore.mockRejectedValueOnce(new Error("Missing handwriting; both copies kept"));
  const buttons = host.querySelectorAll<HTMLButtonElement>(".lc-scratch-load-entry button");
  await click(buttons[1]!); await click(buttons[1]!);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Missing handwriting; both copies kept");
  expect(refreshed).not.toHaveBeenCalled(); expect(host.querySelectorAll(".lc-scratch-load-entry")).toHaveLength(3);
});
