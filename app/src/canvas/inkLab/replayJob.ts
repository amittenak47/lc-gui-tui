/** Time-sliced committed replay so opening a notebook cannot pin the UI. */

import type { InkDrawOp, InkEraseOp, InkOp, ViewportTransform } from "../rasterInk";
import { EraseClipJob } from "../strokeEraser";
import type { SpineDot } from "./instance";
import { appendLabSpineRange } from "./replay";

export const REPLAY_SLICE_MS = 3;
export const REPLAY_POINT_CHUNK = 192;

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
  private clipJob: EraseClipJob | null = null;

  constructor(private readonly source: readonly InkOp[]) {}

  step(now: () => number, budgetMs = REPLAY_SLICE_MS): boolean {
    const started = now();
    let didWork = false;
    while (this.sourceIndex < this.source.length || this.eraseSource) {
      if (didWork && now() - started >= budgetMs) return false;
      didWork = true;

      if (this.eraseSource && this.erase) {
        const op = this.eraseSource[this.eraseIndex];
        if (op) {
          if (op.kind !== "draw") {
            this.eraseOutput.push(op);
            this.eraseIndex += 1;
          } else {
            if (!this.clipJob) this.clipJob = new EraseClipJob(op, this.erase);
            const remaining = Math.max(0, budgetMs - (now() - started));
            if (!this.clipJob.step(now, remaining)) return false;
            const pieces = this.clipJob.result();
            if (pieces == null) this.eraseOutput.push(op);
            else this.eraseOutput.push(...pieces);
            this.clipJob = null;
            this.eraseIndex += 1;
          }
        }
        if (this.eraseIndex < this.eraseSource.length) continue;
        this.output = this.eraseOutput;
        this.eraseSource = null;
        this.eraseOutput = [];
        this.eraseIndex = 0;
        this.erase = null;
        this.clipJob = null;
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

/**
 * Camera-space spine conversion bounded by points, not strokes. A single long
 * stroke must not consume an entire loading frame merely because it is one op.
 */
export class OverlaySpineJob {
  private opIndex = 0;
  private pointIndex = 0;
  private consumed = 0;
  private current: SpineDot[] = [];
  private output: SpineDot[][] = [];

  constructor(
    private readonly source: readonly InkDrawOp[],
    private readonly viewport: Pick<ViewportTransform, "zoom" | "scrollX" | "scrollY">,
    private readonly dpr: number,
  ) {}

  step(now: () => number, budgetMs = REPLAY_SLICE_MS): boolean {
    const started = now();
    let didWork = false;
    const k = Math.max(1e-6, this.viewport.zoom * this.dpr);
    while (this.opIndex < this.source.length) {
      if (didWork && now() - started >= budgetMs) return false;
      const op = this.source[this.opIndex]!;
      if (this.pointIndex >= op.points.length) {
        this.output.push(this.current);
        this.current = [];
        this.pointIndex = 0;
        this.consumed = 0;
        this.opIndex += 1;
        continue;
      }
      didWork = true;
      const end = Math.min(op.points.length, this.pointIndex + REPLAY_POINT_CHUNK);
      const from = this.current.length;
      this.consumed = appendLabSpineRange(
        op,
        this.current,
        this.pointIndex,
        end,
        this.consumed,
      );
      for (let i = from; i < this.current.length; i++) {
        const dot = this.current[i]!;
        dot.x = (dot.x + this.viewport.scrollX) * k;
        dot.y = (dot.y + this.viewport.scrollY) * k;
        dot.r *= k;
      }
      this.pointIndex = end;
    }
    return true;
  }

  result(): SpineDot[][] {
    if (this.opIndex < this.source.length) {
      throw new Error("overlay spine conversion is not complete");
    }
    return this.output;
  }
}
