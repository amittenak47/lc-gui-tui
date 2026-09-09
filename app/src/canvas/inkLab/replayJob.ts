/** Time-sliced committed replay so opening a notebook cannot pin the UI. */

import type { InkEraseOp, InkOp } from "../rasterInk";
import { clipDrawOpOutsideErase } from "../strokeEraser";

export const REPLAY_SLICE_MS = 8;

/**
 * Paint `[from, n)` until `budgetMs` elapses. Always paints at least one
 * index so a single expensive stroke still makes progress.
 */
export function replayUntil(
  from: number,
  n: number,
  now: () => number,
  budgetMs: number,
  paintOne: (index: number) => void,
): number {
  if (from >= n) return n;
  const t0 = now();
  let i = from;
  while (i < n && (i === from || now() - t0 < budgetMs)) {
    paintOne(i);
    i += 1;
  }
  return i;
}

/**
 * Incremental form of `opsWithErasesBaked`.
 *
 * A dense restored page can contain thousands of legacy draw ops followed by
 * erase ops. The old replay sliced only GPU submission; it still baked this
 * entire list before yielding, which was the UI-thread stall on open. This job
 * can pause both between source ops and while one erase walks prior strokes.
 */
export class EraseBakeJob {
  private sourceIndex = 0;
  private output: InkOp[] = [];
  private eraseSource: InkOp[] | null = null;
  private eraseOutput: InkOp[] = [];
  private eraseIndex = 0;
  private erase: InkEraseOp | null = null;

  constructor(private readonly source: readonly InkOp[]) {}

  step(now: () => number, budgetMs = REPLAY_SLICE_MS): boolean {
    const started = now();
    let didWork = false;
    while (this.sourceIndex < this.source.length || this.eraseSource) {
      if (didWork && now() - started >= budgetMs) return false;
      didWork = true;

      if (this.eraseSource && this.erase) {
        const op = this.eraseSource[this.eraseIndex++];
        if (op) {
          if (op.kind !== "draw") {
            this.eraseOutput.push(op);
          } else {
            const pieces = clipDrawOpOutsideErase(op, this.erase);
            if (pieces == null) this.eraseOutput.push(op);
            else this.eraseOutput.push(...pieces);
          }
        }
        if (this.eraseIndex < this.eraseSource.length) continue;
        this.output = this.eraseOutput;
        this.eraseSource = null;
        this.eraseOutput = [];
        this.eraseIndex = 0;
        this.erase = null;
        continue;
      }

      const op = this.source[this.sourceIndex++];
      if (!op) continue;
      if (op.kind === "erase") {
        this.erase = op;
        this.eraseSource = this.output;
        this.eraseOutput = [];
        this.eraseIndex = 0;
        if (this.eraseSource.length === 0) {
          this.eraseSource = null;
          this.erase = null;
        }
      } else {
        this.output.push(op);
      }
    }
    return true;
  }

  result(): InkOp[] {
    if (this.sourceIndex < this.source.length || this.eraseSource) {
      throw new Error("erase bake is not complete");
    }
    return this.output;
  }
}
