import type { InkOp, SceneBounds } from "../rasterInk";
import { inkTileCanvasPx, TILE_PX } from "../inkTileGrid";
import { paintInkTile } from "./tilePaint";

export type InkTileRasterRequest =
  | {
      type: "ops";
      ops: InkOp[];
      clip: SceneBounds | null;
      tilePx?: number;
    }
  | {
      type: "render";
      id: number;
      level: number;
      tx: number;
      ty: number;
    };

export type InkTileRasterResponse = {
  id: number;
  bitmap: ImageBitmap | null;
  renderMs: number;
  sdfMs: number;
};

let ops: InkOp[] = [];
let clip: SceneBounds | null = null;
let tilePx = TILE_PX;

function paintOne(id: number, level: number, tx: number, ty: number): void {
  const started = performance.now();
  const px = inkTileCanvasPx(tilePx);
  const fail = () => {
    (self as unknown as Worker).postMessage({
      id,
      bitmap: null,
      renderMs: performance.now() - started,
      sdfMs: 0,
    } satisfies InkTileRasterResponse);
  };
  if (typeof OffscreenCanvas !== "function") {
    fail();
    return;
  }
  const canvas = new OffscreenCanvas(px, px);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    fail();
    return;
  }
  const painted = paintInkTile(
    ctx as unknown as CanvasRenderingContext2D,
    { ops, clip, level, tx, ty, tilePx },
  );
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = canvas.transferToImageBitmap();
  } catch {
    bitmap = null;
  }
  const payload: InkTileRasterResponse = {
    id,
    bitmap,
    renderMs: performance.now() - started,
    sdfMs: painted.sdfMs,
  };
  const transfer: Transferable[] = bitmap ? [bitmap] : [];
  (self as unknown as Worker).postMessage(payload, transfer);
}

self.onmessage = (event: MessageEvent<InkTileRasterRequest>) => {
  const msg = event.data;
  if (msg.type === "ops") {
    ops = msg.ops;
    clip = msg.clip;
    if (msg.tilePx) tilePx = msg.tilePx;
    return;
  }
  paintOne(msg.id, msg.level, msg.tx, msg.ty);
};
