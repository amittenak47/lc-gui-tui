import { expect, it, vi } from "vitest";
import { flushInkSnapshot } from "./flushInkSnapshot";
import type { EncodedInk } from "../canvas/inkCodec";

it("keeps newly drawn ink dirty until its own snapshot has been saved", async () => {
  let revision = 1;
  let release!: () => void;
  const board = {
    getInkRevision: () => revision,
    takeDirtyInkPages: () => new Map<number, EncodedInk>([[1, { v: 2, ops: [] }]]),
    markInkPagesFlushed: vi.fn(),
  };
  const saved = flushInkSnapshot(board, () => new Promise<void>(resolve => { release = resolve; }));
  revision++;
  release();
  expect(await saved).toBe(false);
  expect(board.markInkPagesFlushed).not.toHaveBeenCalled();
  expect(await flushInkSnapshot(board, async () => {})).toBe(true);
  expect([...board.markInkPagesFlushed.mock.calls[0][0]]).toEqual([1]);
});

it("retains dirty ink after a failed write", async () => {
  const board = { getInkRevision: () => 1, takeDirtyInkPages: () => new Map<number, EncodedInk>([[1, { v: 2, ops: [] }]]), markInkPagesFlushed: vi.fn() };
  await expect(flushInkSnapshot(board, async () => { throw Error("disk"); })).rejects.toThrow("disk");
  expect(board.markInkPagesFlushed).not.toHaveBeenCalled();
});
