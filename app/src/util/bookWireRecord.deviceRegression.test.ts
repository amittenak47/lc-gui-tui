import { beforeEach, expect, it, vi } from "vitest";
import { encodeInkOps, reviveEncodedInk, decodeInkOps } from "../canvas/inkCodec";
import type { LcClient, PadSnapshotDto } from "../api/client";
import { bookWireRecord } from "./bookWireRecord";
import { canonicalJson, recordHash, snapshotCopyHash } from "./syncContent";

const retained = vi.hoisted(() => new Map<string, import("./padSnapshotStore").PadSnapshot>());
vi.mock("./padSnapshotStore", async original => ({
  ...await original<typeof import("./padSnapshotStore")>(),
  listAllPadSnapshots: async () => [...retained.values()],
  getPadSnapshot: async (_kind: string, _key: string, _tier: string, id: string) => retained.get(id) ?? null,
}));
import { syncBookBackups } from "./bookSyncPass";

beforeEach(() => retained.clear());

const transcript = () => [{ id: "turn", content: "Saved explanation", processEvents: [
  { kind: "stage", label: "reason", ts: 0, detail: undefined, status: undefined, updateId: undefined, future: { kept: true } },
  { kind: "tool", label: "draw", ts: 1, detail: "", status: "accepted", updateId: "event" },
] }];
const ink = () => encodeInkOps([{ kind: "draw", color: "#111111", baseWidth: 2, maxFullness: .8,
  pressureClip: .6, pressureSensitive: true, points: [{ x: 1, y: 2, pressure: .5 }, { x: 4, y: 5, pressure: .8 }] }]);
const board = () => ({ v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 }, inkC: ink() });

it("hashes saved process events with absent optional fields without losing defined events", async () => {
  const original = { id: "book", agent: transcript() };
  const wire = bookWireRecord(original);
  expect(wire).toStrictEqual(JSON.parse(JSON.stringify(original)));
  await expect(recordHash(wire)).resolves.toMatch(/^[a-f0-9]{64}$/);
  expect(Object.hasOwn(original.agent[0]!.processEvents[0]!, "status")).toBe(true);
  expect(original.agent[0]!.processEvents[0]!.future).toEqual({ kept: true });
});

it("retains unknown unsupported event fields for strict validation", () => {
  for (const event of [{ future: undefined }, { future: { status: undefined } }]) {
    const wire = bookWireRecord({ agent: [{ processEvents: [event] }] });
    expect(() => canonicalJson(wire)).toThrow("unsupported JSON value");
  }
});

it("preserves every ink channel in primary and scratch boards on the wire", () => {
  const original = { board: board(), footnote_boards: { scratch: { board: board(), pageCount: 1 } } };
  const wire = bookWireRecord(original);
  expect(wire).toStrictEqual(JSON.parse(JSON.stringify(original)));
  const primary = wire.board as ReturnType<typeof board>;
  const scratch = (wire.footnote_boards as typeof original.footnote_boards).scratch.board;
  for (const converted of [primary, scratch]) {
    const restored = reviveEncodedInk(converted.inkC);
    expect(restored).not.toBeNull();
    expect(decodeInkOps(restored!)).toEqual(decodeInkOps(original.board.inkC));
  }
  expect(original.board.inkC.ops[0]!.xy).toBeInstanceOf(Int16Array);
});

it("transfers retained snapshots with nested events and typed scratch ink without mutating them", async () => {
  const snapshot = { snapshotId: "copy", kind: "annotate" as const, key: "book", tier: "2h" as const,
    writtenAt: 1, name: "Retained book", board: board(), agent: transcript(), source: "# Retained source",
    footnoteBoards: { scratch: { board: board(), pageCount: 1 } }, footnoteInk: undefined };
  retained.set("copy", snapshot);
  const saved = structuredClone(snapshot);
  const putSnapshotCopy = vi.fn(async (_kind: string, _key: string, content_hash: string, _body: PadSnapshotDto) => ({ content_hash, tier: "2h", written_at: 1, name: snapshot.name }));
  const client = { listSnapshotCopies: async () => [], putSnapshotCopy } as unknown as LcClient;
  expect(await syncBookBackups(client, new AbortController().signal, 100)).toEqual([]);
  expect(putSnapshotCopy).toHaveBeenCalledTimes(1);
  const body = putSnapshotCopy.mock.calls[0]![3];
  const { kind: _kind, key: _key, tier, writtenAt: _writtenAt, snapshotId: _snapshotId, ...payload } = snapshot;
  const expected = { tier, payload: JSON.parse(JSON.stringify(payload)) };
  expect(body.payload).toStrictEqual(expected.payload);
  expect(putSnapshotCopy.mock.calls[0]![2]).toBe(await snapshotCopyHash(expected));
  expect(snapshot).toStrictEqual(saved);
});
