import { beforeEach, expect, it, vi } from "vitest";
import { getPadSnapshot, recordRollingSnapshots } from "./padSnapshotStore";
import type { ArtifactSnapshotBundle } from "./artifactSnapshot";

const rows = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./idb", async original => ({
  ...await original<typeof import("./idb")>(),
  run: async (_name: string, _mode: string, work: (store: any) => any) => work({
    get: (key: string) => ({ result: structuredClone(rows.get(key)) }),
    put: (row: unknown, key: string) => { rows.set(key, structuredClone(row)); return {}; },
  }).result,
}));
const bundle: ArtifactSnapshotBundle = { v: 1, catalog: { v: 1, parent: { kind: "annotate", id: "a1" }, revision: "c1", artifacts: [] }, assets: [] };
const input = { kind: "annotate" as const, key: "a1", name: "Note.md", now: 10,
  board: { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } },
  extras: async () => ({ artifactBundle: bundle }),
};
beforeEach(() => rows.clear());
it("keeps the exact backup bundle in all due tiers", async () => {
  expect(await recordRollingSnapshots(input)).toHaveLength(3);
  for (const tier of ["2h", "24h", "7d"] as const) {
    expect((await getPadSnapshot("annotate", "a1", tier))?.artifactBundle).toEqual(bundle);
  }
});
it("does not replace existing tiers with a malformed or foreign bundle", async () => {
  await recordRollingSnapshots(input);
  const old = structuredClone([...rows]);
  await expect(recordRollingSnapshots({ ...input, now: 1_000_000_000,
    extras: async () => ({ artifactBundle: { ...bundle, catalog: { ...bundle.catalog, parent: { kind: "annotate", id: "another" } } } }),
  })).rejects.toThrow("different parent");
  expect([...rows]).toEqual(old);
});
