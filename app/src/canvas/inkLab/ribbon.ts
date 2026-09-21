import { clipBlitRect, CLIP_BLIT_PAD } from "./clipBlit";
import { fillMiterStroke } from "./fallback";
import { emptyAabb, expandAabb, type SpineDot, type StrokeAabb } from "./instance";
import { INK_RGB } from "./style";

/** One live raster path for every dial value. Only stable spans enter prefix. */
export function createLiveRibbon(prefix: HTMLCanvasElement) {
  let frozen = 0;
  let previous: StrokeAabb | null = null;
  const clear = () => {
    prefix.getContext("2d")?.clearRect(0, 0, prefix.width, prefix.height);
    frozen = 0;
    previous = null;
  };
  return {
    clear,
    paint(host: HTMLCanvasElement, snap: HTMLCanvasElement | null,
      points: readonly SpineDot[], stableTo: number): StrokeAabb {
      const ctx = host.getContext("2d")!;
      const pctx = prefix.getContext("2d")!;
      if (prefix.width !== host.width || prefix.height !== host.height) {
        prefix.width = host.width;
        prefix.height = host.height;
        frozen = 0;
        previous = null;
      }
      const next = Math.max(frozen, Math.min(stableTo, points.length - 1));
      const dirty = emptyAabb();
      // Old tail plus newly frozen span, never the accumulated stroke box.
      for (let i = frozen; i < points.length; i++) {
        const p = points[i]!;
        expandAabb(dirty, { ...p, r: p.r * 2 });
      }
      if (previous) {
        dirty.minX = Math.min(dirty.minX, previous.minX);
        dirty.minY = Math.min(dirty.minY, previous.minY);
        dirty.maxX = Math.max(dirty.maxX, previous.maxX);
        dirty.maxY = Math.max(dirty.maxY, previous.maxY);
      }
      if (next > frozen) {
        fillMiterStroke(pctx, points, null, INK_RGB,
          { from: frozen, to: next, capHead: frozen === 0, capEnd: false });
        frozen = next;
      }
      previous = emptyAabb();
      for (let i = frozen; i < points.length; i++) {
        const p = points[i]!;
        expandAabb(previous, { ...p, r: p.r * 2 });
      }
      const clip = clipBlitRect(dirty, host.width, host.height, CLIP_BLIT_PAD);
      if (!clip) return dirty;
      const { x, y, w, h } = clip;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.clearRect(x, y, w, h);
      if (snap) ctx.drawImage(snap, x, y, w, h, x, y, w, h);
      // Crossing an older part of this stroke must not erase that prefix.
      ctx.drawImage(prefix, x, y, w, h, x, y, w, h);
      fillMiterStroke(ctx, points, null, INK_RGB,
        { from: frozen, capHead: frozen === 0 });
      ctx.restore();
      return dirty;
    },
  };
}
