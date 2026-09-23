import type { InkOp, SceneBounds } from "../rasterInk";
import { inkTileCanvasPx, TILE_PX } from "../inkTileGrid";
import { paintInkTile } from "./tilePaint";

export type InkTileRasterRequest =
  | {
      type: "ops";
      historyId: number;
      ops: InkOp[];
      clip: SceneBounds | null;
      tilePx?: number;
    }
  | {
      type: "render";
      historyId: number;
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

type History = { ops: InkOp[]; clip: SceneBounds | null; tilePx: number };
const histories = new Map<number, History>();

function paintOne(id: number, level: number, tx: number, ty: number, history: History): void {
  const { ops, clip, tilePx } = history;
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
    histories.set(msg.historyId, { ops: msg.ops, clip: msg.clip, tilePx: msg.tilePx ?? TILE_PX });
    if (histories.size > 2) histories.delete(histories.keys().next().value!);
    return;
  }
  const history = histories.get(msg.historyId);
  if (!history) {
    (self as unknown as Worker).postMessage({ id: msg.id, bitmap: null, renderMs: 0, sdfMs: 0 } satisfies InkTileRasterResponse);
    return;
  }
  histories.delete(msg.historyId);
  histories.set(msg.historyId, history);
  paintOne(msg.id, msg.level, msg.tx, msg.ty, history);
};
