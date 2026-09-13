import { isHostBoundOp, paintHostBoundOps, type InkOp, type SceneBounds, type ScrollHostLookup } from "../rasterInk";

// Remember geometry separately: the asynchronous smoothing worker can replace
// points on the same op object without changing the book revision.
export class InkGeometrySnapshot {
  private entries: Array<{ op: InkOp; points: InkOp["points"] }> = [];
  capture(ops: readonly InkOp[]): void {
    this.entries = ops.map(op => ({ op, points: op.points }));
  }
  matches(ops: readonly InkOp[]): boolean {
    return ops.length === this.entries.length && ops.every((op, i) =>
      op === this.entries[i]!.op && op.points === this.entries[i]!.points);
  }
}

const TILE = 512;
const LIMIT = 64; // At most 64 MiB, independent of document/content length.
type Host = ScrollHostLookup extends ReadonlyMap<number, infer T> ? T : never;

/** Host ink in unscrolled scene coordinates. Scrolling blits, never re-meshes
 * already cached tiles. The ordinary page remains a separate background. */
export class HostInkRasterCache {
  private geometry = new InkGeometrySnapshot();
  private groups = new Map<number, InkOp[]>();
  private boundOps: InkOp[] = [];
  private tiles = new Map<string, HTMLCanvasElement>();
  private scale = 0;
  constructor(private createCanvas = () => document.createElement("canvas")) {}

  sync(ops: readonly InkOp[]): void {
    const bound = ops.filter(isHostBoundOp);
    if (this.geometry.matches(bound)) return;
    this.geometry.capture(bound);
    this.boundOps = bound;
    this.groups.clear();
    this.tiles.clear();
    for (const op of bound) {
      const key = op.hostKey!;
      const group = this.groups.get(key) ?? [];
      group.push(op);
      this.groups.set(key, group);
    }
  }

  paint(ctx: CanvasRenderingContext2D, hosts: ScrollHostLookup, scale: number, dirty?: SceneBounds): void {
    if (this.scale !== scale) { this.tiles.clear(); this.scale = scale; }
    const transform = ctx.getTransform();
    const visible = [...hosts].filter(([key, { bounds: b }]) => this.groups.has(key) &&
      b.maxX * scale + transform.e > 0 && b.minX * scale + transform.e < ctx.canvas.width &&
      b.maxY * scale + transform.f > 0 && b.minY * scale + transform.f < ctx.canvas.height);
    // Nested/overlapping boxes need the original cross-host stroke order.
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i]![1].bounds, b = visible[j]![1].bounds;
        if (a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY) {
          paintHostBoundOps(ctx, this.boundOps, hosts, scale);
          return;
        }
      }
    }
    for (const [key, host] of hosts) {
      const ops = this.groups.get(key);
      if (!ops?.length) continue;
      const b = host.bounds;
      if (dirty && (b.maxX <= dirty.minX || b.minX >= dirty.maxX || b.maxY <= dirty.minY || b.minY >= dirty.maxY)) continue;
      // Erase/multiply must blend with the page background beneath the box;
      // flattening them onto a transparent cached layer would lose that.
      if (ops.some(op => op.kind === "erase" || op.highlight)) {
        paintHostBoundOps(ctx, ops, hosts, scale);
        continue;
      }
      this.paintHost(ctx, key, host, ops, scale);
    }
    // Keep the existing fallback for hosts temporarily absent during layout.
    for (const [key, ops] of this.groups) {
      if (!hosts.has(key)) paintHostBoundOps(ctx, ops, hosts, scale);
    }
  }

  private paintHost(ctx: CanvasRenderingContext2D, key: number, host: Host, ops: InkOp[], scale: number): void {
    const b = host.bounds;
    const left = host.scrollLeft, top = host.scrollTop ?? 0;
    const span = TILE / scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    ctx.clip();
    // Respect the destination's visible bounds as well as the host. Very tall
    // fences must not raster their entire height just to show one screenful.
    const transform = ctx.getTransform();
    const minY = Math.max(b.minY, -transform.f / scale);
    const maxY = Math.min(b.maxY, (ctx.canvas.height - transform.f) / scale);
    const minX = Math.max(b.minX, -transform.e / scale);
    const maxX = Math.min(b.maxX, (ctx.canvas.width - transform.e) / scale);
    for (let y = Math.floor((minY + top) / span); y < Math.ceil((maxY + top) / span); y++) {
      for (let x = Math.floor((minX + left) / span); x < Math.ceil((maxX + left) / span); x++) {
        const id = `${key}:${x}:${y}`;
        let tile = this.tiles.get(id);
        if (!tile) {
          tile = this.createCanvas();
          tile.width = tile.height = TILE;
          const tc = tile.getContext("2d");
          if (!tc) continue;
          tc.setTransform(scale, 0, 0, scale, -x * TILE, -y * TILE);
          const bounds: SceneBounds = { minX: x * span, minY: y * span, maxX: (x + 1) * span, maxY: (y + 1) * span };
          paintHostBoundOps(tc, ops, new Map([[key, { bounds, scrollLeft: 0, scrollTop: 0 }]]), scale);
        }
        this.tiles.delete(id);
        this.tiles.set(id, tile);
        while (this.tiles.size > LIMIT) this.tiles.delete(this.tiles.keys().next().value!);
        ctx.drawImage(tile, x * span - left, y * span - top, span, span);
      }
    }
    ctx.restore();
  }
}
