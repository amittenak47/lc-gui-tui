/**
 * Replay a spine with the same WebGL capsules the live lab engine uses.
 *
 * Maps scene-space dots through the dest CTM (tile, overlay, host translate)
 * and blits in device pixels so clip() still applies — host-bound scroll and
 * page clip stay on the 2d context.
 */

import {
  emptyAabb,
  expandAabb,
  INSTANCE_FLOATS,
  writeInstance,
  type SpineDot,
} from "./instance";
import { tryCreateSdfRenderer, type SdfRenderer } from "./sdf";
import { INK_RGB } from "./style";

let pooled: SdfRenderer | null | undefined;

function peer(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return null;
  }
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

function mapDot(t: DOMMatrix, d: SpineDot): SpineDot {
  const sx = Math.hypot(t.a, t.b) || 1;
  return {
    ...d,
    x: t.a * d.x + t.c * d.y + t.e,
    y: t.b * d.x + t.d * d.y + t.f,
    r: d.r * sx,
  };
}

function destSize(ctx: CanvasRenderingContext2D): { w: number; h: number } {
  const canvas = ctx.canvas;
  return {
    w: Math.max(1, canvas?.width ?? 1),
    h: Math.max(1, canvas?.height ?? 1),
  };
}

/**
 * True when this dest was painted (including nothing visible).
 * False when WebGL is unavailable — caller should use the canvas2d strip.
 */
export function paintSdfSpine(
  dest: CanvasRenderingContext2D,
  spine: readonly SpineDot[],
  tip: SpineDot | null,
): boolean {
  if (spine.length === 0 && !tip) return true;
  if (typeof dest.getTransform !== "function") return false;

  let transform: DOMMatrix;
  try {
    transform = dest.getTransform();
  } catch {
    return false;
  }

  const mapped: SpineDot[] = [];
  const box = emptyAabb();
  for (const d of spine) {
    const p = mapDot(transform, d);
    mapped.push(p);
    expandAabb(box, p);
  }
  let mappedTip: SpineDot | null = null;
  if (tip) {
    mappedTip = mapDot(transform, tip);
    expandAabb(box, mappedTip);
  }
  if (!Number.isFinite(box.minX)) return true;

  const { w: destW, h: destH } = destSize(dest);
  const pad = 4;
  const x0 = Math.max(0, Math.floor(box.minX) - pad);
  const y0 = Math.max(0, Math.floor(box.minY) - pad);
  const x1 = Math.min(destW, Math.ceil(box.maxX) + pad);
  const y1 = Math.min(destH, Math.ceil(box.maxY) + pad);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 1 || h < 1) return true;

  if (pooled === undefined) {
    pooled = tryCreateSdfRenderer(w, h, peer);
  }
  if (!pooled) {
    pooled = null;
    return false;
  }

  pooled.resize(w, h);
  pooled.clear();

  const extra = mappedTip && mapped.length > 0 ? 1 : 0;
  const inst = new Float32Array(Math.max(1, (mapped.length + extra) * INSTANCE_FLOATS));
  let segs = 0;
  const shift = (d: SpineDot): SpineDot => ({ ...d, x: d.x - x0, y: d.y - y0 });
  for (let i = 1; i < mapped.length; i++) {
    const a = shift(mapped[i - 1]!);
    const b = shift(mapped[i]!);
    writeInstance(inst, segs, a, b, a.rgb ?? INK_RGB, b.rgb ?? INK_RGB);
    segs += 1;
  }
  if (mapped.length === 1) {
    const a = shift(mapped[0]!);
    writeInstance(inst, segs, a, a, a.rgb ?? INK_RGB, a.rgb ?? INK_RGB);
    segs += 1;
  }
  if (mappedTip && mapped.length > 0) {
    const last = mapped[mapped.length - 1]!;
    const same =
      Math.hypot(mappedTip.x - last.x, mappedTip.y - last.y) < 0.05 &&
      Math.abs(mappedTip.r - last.r) < 0.05;
    if (!same) {
      const a = shift(last);
      const b = shift(mappedTip);
      writeInstance(inst, segs, a, b, a.rgb ?? INK_RGB, b.rgb ?? INK_RGB);
      segs += 1;
    }
  } else if (mapped.length === 0 && mappedTip) {
    const a = shift(mappedTip);
    writeInstance(inst, segs, a, a, a.rgb ?? INK_RGB, a.rgb ?? INK_RGB);
    segs += 1;
  }
  if (segs < 1) return true;

  pooled.upload(inst, segs);
  pooled.draw({ minX: 0, minY: 0, maxX: w, maxY: h });
  dest.save();
  dest.setTransform(1, 0, 0, 1, 0, 0);
  dest.drawImage(pooled.canvas, x0, y0);
  dest.restore();
  return true;
}
