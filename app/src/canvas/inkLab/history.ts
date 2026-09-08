/**
 * Overlay + pixel stacks for ink-lab undo/redo.
 *
 * The book already keeps op history. These stacks keep the GPU snap from
 * having to remesh every remaining stroke on Ctrl+Z.
 */

import { INK_UNDO_CAP } from "../inkPageCache";
import type { SpineDot } from "./instance";

export function pushCapped<T>(stack: T[], item: T, cap = INK_UNDO_CAP): void {
  stack.push(item);
  if (stack.length > cap) stack.splice(0, stack.length - cap);
}

export function commitOverlay(
  committed: SpineDot[][],
  redo: SpineDot[][],
  spine: SpineDot[],
): void {
  committed.push(spine);
  redo.length = 0;
}

export function undoOverlay(
  committed: SpineDot[][],
  redo: SpineDot[][],
): SpineDot[] | undefined {
  const spine = committed.pop();
  if (!spine) return undefined;
  redo.push(spine);
  return spine;
}

export function redoOverlay(
  committed: SpineDot[][],
  redo: SpineDot[][],
): SpineDot[] | undefined {
  const spine = redo.pop();
  if (!spine) return undefined;
  committed.push(spine);
  return spine;
}
