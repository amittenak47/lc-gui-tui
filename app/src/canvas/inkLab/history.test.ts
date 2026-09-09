import { describe, expect, it } from "vitest";

import { INK_UNDO_CAP } from "../inkPageCache";
import type { SpineDot } from "./instance";
import { commitOverlay, dropRedoStacks, pushCapped, redoOverlay, undoOverlay } from "./history";

function spine(x: number): SpineDot[] {
  return [
    { x, y: 0, r: 1 },
    { x: x + 4, y: 0, r: 1 },
  ];
}

describe("ink lab overlay stacks", () => {
  it("undo pops onto redo, redo pushes back, a new stroke drops redo", () => {
    const committed: SpineDot[][] = [];
    const redo: SpineDot[][] = [];
    const a = spine(0);
    const b = spine(10);
    const c = spine(20);
    commitOverlay(committed, redo, a);
    commitOverlay(committed, redo, b);
    expect(undoOverlay(committed, redo)).toBe(b);
    expect(committed).toEqual([a]);
    expect(redo).toEqual([b]);
    expect(redoOverlay(committed, redo)).toBe(b);
    expect(committed).toEqual([a, b]);
    expect(redo).toHaveLength(0);
    expect(undoOverlay(committed, redo)).toBe(b);
    commitOverlay(committed, redo, c);
    expect(committed).toEqual([a, c]);
    expect(redo).toHaveLength(0);
  });

  it("undo then a new stroke then undo/redo stays on the overlay stacks", () => {
    const committed: SpineDot[][] = [];
    const overlayRedo: SpineDot[][] = [];
    const pixelUndo: Array<number | null> = [];
    const pixelRedo: Array<number | null> = [];
    const a = spine(0);
    const b = spine(10);
    const c = spine(20);
    const d = spine(30);
    commitOverlay(committed, overlayRedo, a);
    pushCapped(pixelUndo, 1);
    dropRedoStacks(overlayRedo, pixelRedo);
    commitOverlay(committed, overlayRedo, b);
    pushCapped(pixelUndo, 2);
    dropRedoStacks(overlayRedo, pixelRedo);
    commitOverlay(committed, overlayRedo, c);
    pushCapped(pixelUndo, 3);
    dropRedoStacks(overlayRedo, pixelRedo);

    expect(undoOverlay(committed, overlayRedo)).toBe(c);
    pixelRedo.push(pixelUndo.pop()!);
    expect(undoOverlay(committed, overlayRedo)).toBe(b);
    pixelRedo.push(pixelUndo.pop()!);
    expect(overlayRedo).toEqual([c, b]);
    expect(pixelRedo).toEqual([3, 2]);

    commitOverlay(committed, overlayRedo, d);
    pushCapped(pixelUndo, 4);
    dropRedoStacks(overlayRedo, pixelRedo);
    expect(committed).toEqual([a, d]);
    expect(overlayRedo).toHaveLength(0);
    expect(pixelRedo).toHaveLength(0);

    expect(undoOverlay(committed, overlayRedo)).toBe(d);
    pixelRedo.push(pixelUndo.pop()!);
    expect(redoOverlay(committed, overlayRedo)).toBe(d);
    pixelUndo.push(pixelRedo.pop()!);
    expect(committed).toEqual([a, d]);
    expect(overlayRedo).toHaveLength(0);
    expect(pixelUndo).toEqual([1, 4]);
  });

  it("caps pixel history the same way the book caps undo", () => {
    const stack: number[] = [];
    for (let i = 0; i < INK_UNDO_CAP + 5; i += 1) pushCapped(stack, i);
    expect(stack).toHaveLength(INK_UNDO_CAP);
    expect(stack[0]).toBe(5);
    expect(stack[stack.length - 1]).toBe(INK_UNDO_CAP + 4);
  });
});
