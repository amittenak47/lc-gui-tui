/**
 * Ink lab engine. Host-owned overlay: attach / down / move / up / paint / clear.
 * Camera later is zoom and scrollX/Y numbers, not a scene API.
 */

export type InkLabBackend = "webgl2" | "canvas2d";
export type InkLabBake = "catmull" | "clothoid";

export type InkLabSample = {
  x: number;
  y: number;
  p: number;
  t: number;
};

export type InkLabPaintStats = {
  frameMs: number;
  pts: number;
  segs: number;
  ekfMs: number;
  drawMs: number;
  hold: boolean;
};

export type InkLabEngine = {
  attach(canvas: HTMLCanvasElement): InkLabBackend;
  down(s: InkLabSample): void;
  move(batch: InkLabSample[]): void;
  up(s: InkLabSample): { bakeMs: number; bake: InkLabBake };
  paint(): InkLabPaintStats;
  clear(): void;
  destroy(): void;
};

export type InkLabEngineOpts = {
  clothoid?: boolean;
  capillary?: boolean;
};

const EMPTY_PAINT: InkLabPaintStats = {
  frameMs: 0,
  pts: 0,
  segs: 0,
  ekfMs: 0,
  drawMs: 0,
  hold: false,
};

export function createInkLabEngine(opts: InkLabEngineOpts = {}): InkLabEngine {
  const clothoid = opts.clothoid === true;
  let canvas: HTMLCanvasElement | null = null;
  let backend: InkLabBackend = "canvas2d";

  return {
    attach(el) {
      canvas = el;
      // Live-engine step claims webgl2. Do not probe here: getContext("webgl2")
      // locks the canvas and blocks the 2D snap until shaders exist.
      backend = "canvas2d";
      return backend;
    },
    down() {},
    move() {},
    up() {
      return { bakeMs: 0, bake: clothoid ? "clothoid" : "catmull" };
    },
    paint() {
      return { ...EMPTY_PAINT };
    },
    clear() {
      const el = canvas;
      if (!el) return;
      const ctx = el.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, el.width, el.height);
    },
    destroy() {
      canvas = null;
    },
  };
}
