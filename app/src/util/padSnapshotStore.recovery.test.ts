import { IDBFactory, IDBKeyRange as FakeKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDbForTests, run, STORE_SNAPSHOTS } from "./idb";
import { getPadSnapshot, listPadSnapshots, listAllPadSnapshots, renamePadSnapshots,
  padSnapshotKey, recoveredPadSnapshotKey, type PadSnapshot } from "./padSnapshotStore";
import { encodeInkOps } from "../canvas/inkCodec";

beforeEach(async () => {
  await closeDbForTests();
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", FakeKeyRange);
});
afterEach(async () => { await closeDbForTests(); vi.unstubAllGlobals(); });
const snapshot = (name: string, key = "missing"): PadSnapshot => ({ kind: "whiteboard", key, tier: "2h",
  name, writtenAt: 12, board: { v: 1, elements: [], appState: { scrollX: 2, scrollY: 3, zoom: 1 },
    inkC: encodeInkOps([]) }, source: "retained", pageCount: 1 });

it("lists and reads every recovered same-tier copy without a live parent", async () => {
  const original = snapshot("rolling"), copy = snapshot("queue copy");
  const copyId = recoveredPadSnapshotKey("whiteboard", "missing", "2h", "queue", "job-1");
  await run(STORE_SNAPSHOTS, "readwrite", store => store.put(original, padSnapshotKey("whiteboard", "missing", "2h")));
  await run(STORE_SNAPSHOTS, "readwrite", store => store.put({ ...copy, snapshotId: copyId, future: { keep: true } }, copyId));
  const listed = await listPadSnapshots("whiteboard", "missing");
  expect(listed).toHaveLength(2);
  expect(new Set(listed.map(row => row.snapshotId)).size).toBe(2);
  expect((await getPadSnapshot("whiteboard", "missing", "2h", copyId))?.name).toBe("queue copy");
  expect(await getPadSnapshot("whiteboard", "other", "2h", copyId)).toBeNull();
  expect(await getPadSnapshot("whiteboard", "missing", "7d", copyId)).toBeNull();
  expect(await listAllPadSnapshots()).toHaveLength(2);
  expect(await getPadSnapshot("whiteboard", "missing", "2h")).toEqual(original);
});

it("a key migration retains divergent destination tiers and all additional copies", async () => {
  const target = snapshot("destination", "new"), old = snapshot("source", "old");
  const extraId = recoveredPadSnapshotKey("whiteboard", "old", "2h", "queue", "job");
  await run(STORE_SNAPSHOTS, "readwrite", store => store.put(target, padSnapshotKey("whiteboard", "new", "2h")));
  await run(STORE_SNAPSHOTS, "readwrite", store => store.put(old, padSnapshotKey("whiteboard", "old", "2h")));
  await run(STORE_SNAPSHOTS, "readwrite", store => store.put({ ...old, name: "extra", snapshotId: extraId }, extraId));
  expect(await renamePadSnapshots("whiteboard", "old", "new")).toBe(2);
  expect(await listPadSnapshots("whiteboard", "old")).toEqual([]);
  const copies = await listPadSnapshots("whiteboard", "new");
  expect(copies).toHaveLength(3);
  expect(new Set(copies.map(row => row.name))).toEqual(new Set(["destination", "source", "extra"]));
  expect(await getPadSnapshot("whiteboard", "new", "2h")).toEqual(target);
  for (const copy of copies) expect((await getPadSnapshot(copy.kind, copy.key, copy.tier, copy.snapshotId))?.board.inkC).toEqual(old.board.inkC);
});
