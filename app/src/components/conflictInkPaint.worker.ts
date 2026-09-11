import { paintInkAtScale } from "../canvas/rasterInk";
import { inkOpBounds } from "../canvas/inkTiles";
import { conflictInkBackingSize, type ConflictPaintPage, type ConflictPaintRequest } from "./conflictInkPaintPlan";

let pages = new Map<number, ConflictPaintPage>();
self.onmessage = (event: MessageEvent<ConflictPaintRequest>) => {
  if (event.data.type === "pages") {
    pages = new Map(event.data.pages.map(page => [page.page, page]));
    return;
  }
  const { job } = event.data;
  let bitmap: ImageBitmap | null = null;
  try {
    const page = pages.get(job.page);
    if (page) {
      const size = conflictInkBackingSize(job.width, job.height, job.dpr);
      const canvas = new OffscreenCanvas(size.width, size.height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const origin = { x: page.originX, y: page.originY + job.offsetY / page.scale };
        const bottom = origin.y + job.height / page.scale;
        const ops = page.ops.filter(op => { const bounds = inkOpBounds(op); return bounds.maxY >= origin.y && bounds.minY <= bottom; });
        paintInkAtScale(ctx as unknown as CanvasRenderingContext2D, ops, origin, page.scale * size.dpr);
        bitmap = canvas.transferToImageBitmap();
      }
    }
  } catch { /* The client falls back to time-sliced painting. */ }
  (self as unknown as Worker).postMessage({ key: job.key, bitmap }, bitmap ? [bitmap] : []);
};
