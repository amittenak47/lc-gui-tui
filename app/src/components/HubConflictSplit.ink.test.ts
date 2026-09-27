import { expect, it } from "vitest";
import { paneInkShards } from "./HubConflictSplit";
import type { InkOp } from "../canvas/rasterInk";

const stroke = (color: string) => ({ kind: "draw", color }) as unknown as InkOp;
const local = [{ pageId: 1, ops: [stroke("#f00")] }, { pageId: 2, ops: [stroke("#0f0")] }];
const hub = [{ pageId: 1, ops: [stroke("#00f")] }];
const rows = [{ pageId: 1, hasLocal: true, hasServer: true }];
type Pick = { local?: boolean; server?: boolean };
const draw = (side: "local" | "server", pick: Pick) =>
  paneInkShards(side, side === "local" ? local : hub, side === "local" ? hub : local, rows, (_, s) => pick[s])
    .map((shard) => `${shard.pageId}:${shard.ops.map((op) => (op as { color: string }).color).join()}`);

it("draws undecided handwriting in gray and leaves pages with no choice alone", () => {
  expect(draw("local", {})).toEqual(["1:#9ca3af", "2:#0f0"]);
});

it("previews the kept copy in both panes", () => {
  expect(draw("local", { local: true, server: false })).toEqual(["1:#f00", "2:#0f0"]);
  expect(draw("server", { local: true, server: false })).toEqual(["1:#f00"]);
});

it("draws each side's own copy when both are kept, and nothing when both are dropped", () => {
  expect(draw("server", { local: true, server: true })).toEqual(["1:#00f"]);
  expect(draw("local", { local: false, server: false })).toEqual(["2:#0f0"]);
});
