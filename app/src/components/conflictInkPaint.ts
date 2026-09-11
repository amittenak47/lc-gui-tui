import { paintInkAtScale } from '../canvas/rasterInk';
import { loadInkBoldness } from '../util/inkBoldnessPref';
import { loadInkSpeedBlotBlend } from '../util/inkSpeedPref';
import { conflictInkBackingSize, type ConflictPaintPage, type ConflictPaintJob, type ConflictPaintRequest } from './conflictInkPaintPlan';
export { conflictInkBackingSize, conflictVisibleInkTiles } from './conflictInkPaintPlan';

type Bitmap = ImageBitmap | HTMLCanvasElement;
type Job = { job: ConflictPaintJob; signal: AbortSignal; resolve(value: Bitmap | null): void };

/** One worker per pane. Only one outstanding raster, and obsolete queued work is skipped. */
export class ConflictInkPainter {
  private worker: Worker | null = null;
  private queue: Job[] = [];
  private current: Job | null = null;
  private cache = new Map<string, Bitmap>();
  private cacheBytes = 0;
  private localRunning = false;
  private gone = false;
  private ready: Promise<void>;
  private timer = 0;
  constructor(private pages: ConflictPaintPage[]) {
    // Workers cannot read device-local preferences used by older ink records.
    const boldness = loadInkBoldness(), speedBlotBlend = loadInkSpeedBlotBlend();
    this.pages = pages.map(page => ({ ...page, ops: page.ops.map(op =>
      op.kind === "draw" && (op.boldness == null || op.speedBlotBlend == null)
        ? { ...op, boldness: op.boldness ?? boldness, speedBlotBlend: op.speedBlotBlend ?? speedBlotBlend }
        : op) }));
    this.ready = this.start();
  }
  private async start() {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return;
    try {
      const { default: PaintWorker } = await import("./conflictInkPaint.worker.ts?worker");
      if (this.gone) return;
      const worker = new PaintWorker();
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<{ key: string; bitmap: ImageBitmap | null }>) => {
        if (!this.current || event.data.key !== this.current.job.key) { event.data.bitmap?.close(); return; }
        if (event.data.bitmap) this.finish(event.data.bitmap);
        else this.fallback();
      };
      worker.onerror = () => { this.fallback(); };
      worker.postMessage({ type: "pages", pages: this.pages } satisfies ConflictPaintRequest);
    } catch { this.worker?.terminate(); this.worker = null; }
  }
  paint(job: ConflictPaintJob, signal: AbortSignal): Promise<Bitmap | null> {
    if (this.gone || signal.aborted) return Promise.resolve(null);
    job = { ...job, key: `${job.key}@${job.dpr}` };
    const cached = this.cache.get(job.key);
    if (cached) { this.cache.delete(job.key); this.cache.set(job.key, cached); return Promise.resolve(cached); }
    return new Promise(resolve => { this.queue.push({ job, signal, resolve }); void this.pump(); });
  }
  private async pump() {
    await this.ready;
    if (this.current || this.gone) return;
    let next = this.queue.shift();
    while (next?.signal.aborted) { next.resolve(null); next = this.queue.shift(); }
    if (!next) return;
    const cached = this.cache.get(next.job.key);
    if (cached) { next.resolve(cached); void this.pump(); return; }
    this.current = next;
    if (this.worker) {
      this.timer = window.setTimeout(() => this.fallback(), 15000);
      try { this.worker.postMessage({ type: "paint", job: next.job } satisfies ConflictPaintRequest); }
      catch { this.fallback(); }
    } else void this.paintLocally();
  }
  private fallback() {
    window.clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    if (this.current && !this.localRunning) void this.paintLocally();
  }
  private async paintLocally() {
    const current = this.current;
    if (!current) return;
    this.localRunning = true;
    const page = this.pages.find(page => page.page === current.job.page);
    const canvas = document.createElement("canvas");
    const size = conflictInkBackingSize(current.job.width, current.job.height, current.job.dpr);
    canvas.width = size.width; canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!page || !ctx) { this.finish(null); return; }
    const origin = { x: page.originX, y: page.originY + current.job.offsetY / page.scale };
    let started = performance.now();
    try {
      for (const op of page.ops) {
        if (this.gone || current.signal.aborted) { this.finish(null); return; }
        paintInkAtScale(ctx, [op], origin, page.scale * size.dpr);
        if (performance.now() - started > 5) {
          await new Promise(resolve => window.setTimeout(resolve, 0));
          started = performance.now();
        }
      }
    } catch { this.finish(null); return; }
    this.finish(canvas);
  }
  private finish(bitmap: Bitmap | null) {
    this.localRunning = false;
    window.clearTimeout(this.timer);
    const current = this.current;
    this.current = null;
    if (!current || this.gone) { if (bitmap && "close" in bitmap) bitmap.close(); return; }
    if (bitmap) {
      this.cache.set(current.job.key, bitmap);
      this.cacheBytes += bitmap.width * bitmap.height * 4;
      // Two panes share a tablet GPU: bound memory as well as the entry count.
      while (this.cache.size > 1 && (this.cache.size > 24 || this.cacheBytes > 32 * 1024 * 1024)) {
        const [key, old] = this.cache.entries().next().value!;
        this.cache.delete(key);
        this.cacheBytes -= old.width * old.height * 4;
        if ("close" in old) old.close();
      }
    }
    current.resolve(bitmap);
    void this.pump();
  }
  dispose() {
    this.gone = true;
    window.clearTimeout(this.timer);
    this.worker?.terminate();
    this.current?.resolve(null);
    this.current = null;
    for (const request of this.queue) request.resolve(null);
    this.queue = [];
    for (const bitmap of this.cache.values()) if ("close" in bitmap) bitmap.close();
    this.cache.clear();
    this.cacheBytes = 0;
  }
}
