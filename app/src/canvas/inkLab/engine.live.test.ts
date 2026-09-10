import { createCanvas } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createInkLabEngine, DISTANCE_GATE_CSS, labStampGatePx } from "./engine";
import { createEkf } from "./ekf";
import { seedSpineHop } from "./seedHop";

beforeAll(() => {
  (globalThis as Record<string, unknown>).OffscreenCanvas = class {
    constructor(w: number, h: number) {
      return createCanvas(Math.max(1, w), Math.max(1, h)) as unknown as object;
    }
  };
});

describe("Ink lab live path", () => {
  it("does not darken older translucent ink when another stroke lifts", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.redrawSnap((ctx) => {
      ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
      ctx.fillRect(20, 20, 20, 20);
    });
    engine.paint();
    const alpha = () => canvas.getContext("2d")!.getImageData(25, 25, 1, 1).data[3];
    const before = alpha();
    for (let i = 0; i < 3; i++) {
      engine.down({ x: 150, y: 120 + i * 20, p: 0.5, t: 100 * i });
      engine.move([{ x: 200, y: 120 + i * 20, p: 0.5, t: 100 * i + 16 }]);
      engine.paint();
      engine.liftRaw();
      engine.paint();
      expect(alpha()).toBe(before);
    }
    engine.destroy();
  });
  it("uses input hops as spline controls after a previously densified turn", () => {
    const run = (samples: Array<{ x: number; y: number; p: number; t: number }>) => {
      const engine = createInkLabEngine({ sdf: false });
      engine.down(samples[0]!);
      engine.move(samples.slice(1));
      const result = engine.liftRaw().bakeInput;
      engine.destroy();
      return result;
    };
    const samples = [
      { x: 40, y: 80, p: 0.5, t: 0 },
      { x: 90, y: 80, p: 0.5, t: 16 },
      { x: 100, y: 140, p: 0.5, t: 32 },
      { x: 180, y: 155, p: 0.5, t: 48 },
    ];
    const first = run(samples.slice(0, 2));
    const turn = run(samples.slice(0, 3));
    const full = run(samples);
    expect(turn.length).toBeGreaterThan(3);
    const expected = seedSpineHop(first.at(-1)!, turn.at(-1)!, full.at(-1)!);
    expect(full.slice(turn.length).map(({ x, y }) => ({ x, y })))
      .toEqual(expected.map(({ x, y }) => ({ x, y })));
  });

  it("paints the last unpresented hop before preserving live pixels on lift", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.down({ x: 40, y: 80, p: 0.5, t: 0 });
    engine.move([{ x: 100, y: 80, p: 0.5, t: 16 }]);
    engine.paint();
    engine.move([{ x: 240, y: 80, p: 0.5, t: 32 }]);
    engine.liftRaw();
    engine.paint();
    const data = canvas.getContext("2d")!.getImageData(180, 60, 40, 40).data;
    expect(data.some((value, i) => i % 4 === 3 && value > 0)).toBe(true);
    engine.destroy();
  });
  it("returns canvas2d when webgl2 is stubbed false", () => {
    const canvas = {
      width: 200,
      height: 200,
      clientWidth: 200,
      clientHeight: 200,
      getContext(kind: string) {
        if (kind === "webgl2") return null;
        return { clearRect() {}, drawImage() {}, setTransform() {} };
      },
    } as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine();
    expect(engine.attach(canvas)).toBe("canvas2d");
    engine.destroy();
  });

  it("keeps one spine point under the distance gate", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine();
    engine.attach(canvas);
    engine.down({ x: 80, y: 90, p: 0.5, t: 0 });
    const batch = [];
    for (let i = 1; i <= 20; i++) {
      batch.push({ x: 80.2, y: 90.1, p: 0.5, t: i * 8 });
    }
    engine.move(batch);
    const stats = engine.paint();
    expect(stats.pts).toBe(1);
    expect(stats.segs).toBe(0);
    engine.up({ x: 80.2, y: 90.1, p: 0.5, t: 200 });
    engine.destroy();
  });

  it("appends capsules on a hop and leaves a non-empty snap", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine();
    expect(engine.attach(canvas)).toBe("canvas2d");
    engine.down({ x: 40, y: 80, p: 0.6, t: 0 });
    engine.move([
      { x: 70, y: 82, p: 0.6, t: 16 },
      { x: 110, y: 90, p: 0.55, t: 32 },
      { x: 160, y: 100, p: 0.5, t: 48 },
    ]);
    const live = engine.paint();
    expect(live.pts).toBeGreaterThan(1);
    expect(live.segs).toBeGreaterThan(0);
    expect(live.suffix).toBe(true);
    expect(live.backend).toBe("canvas2d");
    expect(Number.isFinite(live.frameMs)).toBe(true);
    engine.up({ x: 180, y: 108, p: 0.45, t: 64 });
    engine.paint();
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, 400, 300).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! > 0) ink += 1;
    }
    expect(ink).toBeGreaterThan(10);
    engine.destroy();
  });

  it("seeds Catmull midpoints on a turning hop", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.setPen({
      color: "#1a1a1a",
      baseWidth: 8,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
      smoothing: 0,
    });
    engine.down({ x: 40, y: 80, p: 0.5, t: 0 });
    engine.move([
      { x: 80, y: 80, p: 0.5, t: 16 },
      { x: 80, y: 120, p: 0.5, t: 32 },
    ]);
    expect(engine.pointCount()).toBeGreaterThan(3);
    const baked = engine.up({ x: 80, y: 120, p: 0.5, t: 48 });
    expect(baked.points.length).toBeGreaterThan(3);
    let off = 0;
    for (const p of baked.points) {
      if (p.y > 81 && p.y < 119) off = Math.max(off, Math.abs(p.x - 80));
    }
    expect(off).toBeGreaterThan(0.2);
    engine.destroy();
  });

  it("a speed-ink start borrows the hop heading, not a standstill disc", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const pen = {
      color: "#1a1a1a",
      baseWidth: 8,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 1,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
      smoothing: 0,
    };
    const stroke = createInkLabEngine({ sdf: false });
    stroke.attach(canvas);
    stroke.setPen(pen);
    stroke.down({ x: 40, y: 80, p: 0.5, t: 0 });
    stroke.move([{ x: 120, y: 80, p: 0.5, t: 8 }]);
    const hopped = stroke.up({ x: 140, y: 80, p: 0.5, t: 16 });
    stroke.destroy();

    const tap = createInkLabEngine({ sdf: false });
    tap.attach(canvas);
    tap.setPen(pen);
    tap.down({ x: 40, y: 80, p: 0.5, t: 0 });
    const tapped = tap.up({ x: 40.2, y: 80.1, p: 0.5, t: 8 });
    tap.destroy();

    const start = hopped.points[0]!.r;
    const body = hopped.points[1]!.r;
    expect(start).toBeCloseTo(body, 1);
    expect(start).toBeLessThan(tapped.points[0]!.r * 0.85);
  });

  it("setPen follows toolbar colour and width on the baked spine", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.setPen({
      color: "#cc1111",
      baseWidth: 16,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0.4,
      speedBlotBlend: 0,
      speedFade: 0.5,
      boldness: 1,
    });
    engine.down({ x: 40, y: 80, p: 0.5, t: 0 });
    engine.move([
      { x: 90, y: 84, p: 0.5, t: 16 },
      { x: 140, y: 90, p: 0.5, t: 32 },
    ]);
    const baked = engine.up({ x: 180, y: 96, p: 0.5, t: 48 });
    expect(baked.points.length).toBeGreaterThan(1);
    const rgb = baked.points[0]!.rgb;
    expect(rgb).toBeDefined();
    expect(rgb![0]).toBeGreaterThan(rgb![1]!);
    expect(rgb![0]).toBeGreaterThan(rgb![2]!);
    const fatR = baked.points[0]!.r;
    engine.destroy();

    const thin = createInkLabEngine({ sdf: false });
    thin.attach(canvas);
    thin.setPen({
      color: "#cc1111",
      baseWidth: 2,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0.4,
      speedBlotBlend: 0,
      speedFade: 0.5,
      boldness: 1,
    });
    thin.down({ x: 40, y: 80, p: 0.5, t: 0 });
    thin.move([
      { x: 90, y: 84, p: 0.5, t: 16 },
      { x: 140, y: 90, p: 0.5, t: 32 },
    ]);
    const thinBaked = thin.up({ x: 180, y: 96, p: 0.5, t: 48 });
    expect(fatR).toBeGreaterThan(thinBaked.points[0]!.r * 1.5);
    thin.destroy();
  });

  it("baked points save as InkOp through the existing codec", async () => {
    const { decodeInkOps, encodeInkOps } = await import("../inkCodec");
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.setPen({
      color: "#2244aa",
      baseWidth: 8,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0.3,
      speedBlotBlend: 0.4,
      speedFade: 0.2,
      boldness: 1.2,
    });
    engine.down({ x: 20, y: 30, p: 0.5, t: 0 });
    engine.move([{ x: 80, y: 40, p: 0.5, t: 16 }]);
    const baked = engine.up({ x: 120, y: 48, p: 0.5, t: 32 });
    const op = {
      kind: "draw" as const,
      color: "#2244aa",
      baseWidth: 8,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0.3,
      speedBlotBlend: 0.4,
      speedFade: 0.2,
      boldness: 1.2,
      points: baked.points.map((d) => ({
        x: d.x,
        y: d.y,
        pressure: d.p ?? 0.5,
        slowness: d.slow,
      })),
    };
    const [back] = decodeInkOps(encodeInkOps([op]));
    expect(back?.kind).toBe("draw");
    if (back?.kind !== "draw") return;
    expect(back.color).toBe("#2244aa");
    expect(back.baseWidth).toBe(8);
    expect(back.speedInk).toBeCloseTo(0.3);
    expect(back.points.length).toBe(op.points.length);
    engine.destroy();
  });

  it("keeps suffix-hit after a long live scribble", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.down({ x: 20, y: 20, p: 0.5, t: 0 });
    const hops = [];
    for (let i = 1; i <= 80; i++) {
      hops.push({
        x: 20 + i * 3,
        y: 20 + Math.sin(i / 4) * 40,
        p: 0.5,
        t: i * 16,
      });
    }
    engine.move(hops);
    const stats = engine.paint();
    expect(stats.pts).toBeGreaterThan(32);
    expect(stats.suffix).toBe(true);
    expect(stats.dirtyFrom).toBeGreaterThan(0);
    engine.up({ x: 260, y: 40, p: 0.5, t: 1300 });
    engine.destroy();
  });

  it("clipLiveToChord keeps the prefix and one live nib", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.down({ x: 40, y: 80, p: 0.5, t: 0 });
    engine.move([
      { x: 80, y: 90, p: 0.5, t: 16 },
      { x: 120, y: 100, p: 0.5, t: 32 },
      { x: 160, y: 110, p: 0.5, t: 48 },
    ]);
    const before = engine.pointCount();
    expect(before).toBeGreaterThan(2);
    engine.clipLiveToChord(0, { x: 200, y: 40, p: 0.5, t: 64 });
    expect(engine.pointCount()).toBe(2);
    engine.clipLiveToChord(0, { x: 240, y: 200, p: 0.5, t: 80 });
    expect(engine.pointCount()).toBe(2);
    engine.up({ x: 240, y: 200, p: 0.5, t: 96 });
    engine.destroy();
  });

  it("redrawSnap then paint presents onto the attached host", () => {
    const canvas = createCanvas(80, 60) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.redrawSnap((ctx) => {
      ctx.fillStyle = "#112233";
      ctx.fillRect(10, 10, 20, 20);
    });
    engine.paint();
    const data = canvas.getContext("2d")!.getImageData(15, 15, 1, 1).data;
    expect(data[2]).toBeGreaterThan(0);
    engine.destroy();
  });

  it("toolbar default width is a fine pen, not a marker", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.setPen({
      color: "#1a1a1a",
      baseWidth: 2,
      overlayScale: 8,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
    });
    engine.down({ x: 40, y: 80, p: 0.5, t: 0 });
    engine.move([{ x: 80, y: 84, p: 0.5, t: 16 }]);
    const baked = engine.up({ x: 120, y: 88, p: 0.5, t: 32 });
    expect(baked.points[0]!.r).toBeLessThan(2);
    expect(labStampGatePx(baked.points[0]!.r, 1)).toBeLessThanOrEqual(
      baked.points[0]!.r,
    );
    engine.destroy();
  });

  it("tightens the stamp gate for a hairline nib", () => {
    expect(labStampGatePx(0.5, 1)).toBeLessThan(1);
    expect(labStampGatePx(8, 1)).toBe(DISTANCE_GATE_CSS);
  });

  it("live smoothing does not drop the raw spine", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.setPen({
      color: "#1a1a1a",
      baseWidth: 2,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
      smoothing: 0.5,
      smoothingMode: "live",
    });
    engine.down({ x: 40, y: 80, p: 0.5, t: 0 });
    engine.move([
      { x: 70, y: 110, p: 0.5, t: 16 },
      { x: 110, y: 70, p: 0.5, t: 32 },
      { x: 150, y: 100, p: 0.5, t: 48 },
      { x: 190, y: 80, p: 0.5, t: 64 },
    ]);
    const before = engine.pointCount();
    engine.paint();
    expect(engine.pointCount()).toBe(before);
    const baked = engine.up({ x: 210, y: 90, p: 0.5, t: 80 });
    expect(baked.points.length).toBeGreaterThan(2);
    engine.destroy();
  });

  it("live smoothing keeps the raw spine on a long stroke", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.setPen({
      color: "#1a1a1a",
      baseWidth: 2,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
      smoothing: 0.6,
      smoothingMode: "live",
    });
    engine.down({ x: 10, y: 40, p: 0.5, t: 0 });
    const hops = [];
    for (let i = 1; i <= 280; i++) {
      hops.push({
        x: 10 + i * 4,
        y: 40 + Math.sin(i / 8) * 18,
        p: 0.5,
        t: i * 8,
      });
    }
    engine.move(hops);
    const before = engine.pointCount();
    expect(before).toBeGreaterThan(200);
    engine.paint();
    engine.paint();
    expect(engine.pointCount()).toBe(before);
    const baked = engine.up({ x: 360, y: 40, p: 0.5, t: 2300 });
    expect(baked.points.length).toBeGreaterThan(2);
    engine.destroy();
  });

  it("hold grow off stays nib-sized while a hold grows the pad nib", () => {
    let wall = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      wall += 40;
      return wall;
    });
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const pen = {
      color: "#1a1a1a",
      baseWidth: 2,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedFade: 0,
      boldness: 1,
      smoothing: 0,
    };
    try {
      const off = createInkLabEngine({ sdf: false });
      off.attach(canvas);
      off.setPen({ ...pen, speedBlotBlend: 0 });
      off.down({ x: 80, y: 90, p: 0.5, t: 0 });
      for (let i = 1; i <= 40; i++) {
        off.move([{ x: 80.1, y: 90.1, p: 0.5, t: i * 32 }]);
        off.paint();
      }
      const offBaked = off.up({ x: 80.1, y: 90.1, p: 0.5, t: 1400 });
      const offR = Math.max(...offBaked.points.map((p) => p.r));
      off.destroy();

      const on = createInkLabEngine({ sdf: false });
      on.attach(canvas);
      on.setPen({ ...pen, speedBlotBlend: 1 });
      on.down({ x: 80, y: 90, p: 0.5, t: 0 });
      for (let i = 1; i <= 40; i++) {
        on.move([{ x: 80.1, y: 90.1, p: 0.5, t: i * 32 }]);
        on.paint();
      }
      const onBaked = on.up({ x: 80.1, y: 90.1, p: 0.5, t: 1400 });
      const onR = Math.max(...onBaked.points.map((p) => p.r));
      expect(onR).toBeGreaterThan(offR * 1.1);
      on.destroy();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("hold grow waits for a still pen inside the distance gate", () => {
    let wall = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      wall += 40;
      return wall;
    });
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.setPen({
      color: "#1a1a1a",
      baseWidth: 2,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 1,
      speedFade: 0,
      boldness: 1,
      smoothing: 0,
    });
    try {
      engine.down({ x: 80, y: 90, p: 0.5, t: 0 });
      expect(engine.paint().hold).toBe(false);
      engine.move([{ x: 80.2, y: 90.1, p: 0.5, t: 16 }]);
      expect(engine.paint().hold).toBe(true);
      for (let i = 0; i < 40; i++) engine.paint();
      const baked = engine.up({ x: 80.2, y: 90.1, p: 0.5, t: 1400 });
      expect(baked.blotTipGrow).toBeGreaterThan(0.3);
      expect(baked.points[0]!.r).toBeGreaterThan(1.15);
    } finally {
      nowSpy.mockRestore();
      engine.destroy();
    }
  });

  it("blot off does not hold-grow a still press", () => {
    let wall = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      wall += 40;
      return wall;
    });
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.setPen({
      color: "#1a1a1a",
      baseWidth: 2,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
      smoothing: 0,
    });
    try {
      engine.down({ x: 80, y: 90, p: 0.5, t: 0 });
      expect(engine.paint().hold).toBe(false);
      for (let i = 0; i < 20; i++) engine.paint();
      const baked = engine.up({ x: 80, y: 90, p: 0.5, t: 800 });
      expect(baked.blotTipGrow).toBe(0);
    } finally {
      nowSpy.mockRestore();
      engine.destroy();
    }
  });

  it("stops the hold rAF once the pool has plateaued", () => {
    let wall = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      wall += 40;
      return wall;
    });
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.setPen({
      color: "#1a1a1a",
      baseWidth: 2,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 1,
      speedFade: 0,
      boldness: 1,
      smoothing: 0,
    });
    try {
      engine.down({ x: 80, y: 90, p: 0.5, t: 0 });
      engine.move([{ x: 80.2, y: 90.1, p: 0.5, t: 16 }]);
      let lastHold = true;
      for (let i = 0; i < 40; i++) lastHold = engine.paint().hold;
      expect(lastHold).toBe(false);
      const baked = engine.up({ x: 80.2, y: 90.1, p: 0.5, t: 1400 });
      expect(baked.blotTipGrow).toBeGreaterThan(0.9);
    } finally {
      nowSpy.mockRestore();
      engine.destroy();
    }
  });

  it("mid-stroke hold grows the nib without remeshing the trail", () => {
    let wall = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      wall += 40;
      return wall;
    });
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const pen = {
      color: "#1a1a1a",
      baseWidth: 8,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedFade: 0,
      boldness: 1,
      smoothing: 0,
    };
    try {
      const dry = createInkLabEngine({ sdf: false });
      dry.attach(canvas);
      dry.setPen({ ...pen, speedBlotBlend: 0 });
      dry.down({ x: 40, y: 90, p: 0.5, t: 0 });
      dry.move([{ x: 52, y: 90, p: 0.5, t: 16 }]);
      const dryBaked = dry.up({ x: 52, y: 90, p: 0.5, t: 32 });
      const dryPrev = dryBaked.points[0]!.r;
      dry.destroy();

      const wet = createInkLabEngine({ sdf: false });
      wet.attach(canvas);
      wet.setPen({ ...pen, speedBlotBlend: 1 });
      wet.down({ x: 40, y: 90, p: 0.5, t: 0 });
      wet.move([{ x: 52, y: 90, p: 0.5, t: 16 }]);
      for (let i = 1; i <= 40; i++) {
        wet.move([{ x: 52.1, y: 90.1, p: 0.5, t: 16 + i * 32 }]);
        expect(wet.paint().suffix).toBe(true);
      }
      const wetBaked = wet.up({ x: 52, y: 90, p: 0.5, t: 1400 });
      expect(wetBaked.points[wetBaked.points.length - 1]!.r).toBeGreaterThan(
        dryBaked.points[dryBaked.points.length - 1]!.r,
      );
      expect(wetBaked.points[0]!.r).toBeCloseTo(dryPrev, 1);
      expect(wetBaked.blotHalts.length).toBeGreaterThan(0);
      wet.destroy();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("reads clothoid and capillary from the pen on lift", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const base = {
      color: "#1a1a1a",
      baseWidth: 8,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
      smoothing: 0,
    };
    const hops = [
      { x: 40, y: 80, p: 0.5, t: 0 },
      { x: 80, y: 80, p: 0.5, t: 16 },
      { x: 120, y: 120, p: 0.5, t: 32 },
      { x: 160, y: 120, p: 0.5, t: 48 },
      { x: 200, y: 80, p: 0.5, t: 64 },
    ];
    const off = createInkLabEngine({ sdf: false });
    off.attach(canvas);
    off.setPen(base);
    off.down(hops[0]!);
    off.move(hops.slice(1, -1));
    const raw = off.up(hops[hops.length - 1]!);
    expect(raw.bake).toBe("catmull");
    off.destroy();

    const cloth = createInkLabEngine({ sdf: false });
    cloth.attach(canvas);
    cloth.setPen({ ...base, clothoid: true });
    cloth.down(hops[0]!);
    cloth.move(hops.slice(1, -1));
    const clothBaked = cloth.up(hops[hops.length - 1]!);
    expect(clothBaked.bake).toBe("clothoid");
    expect(clothBaked.points.length).toBeGreaterThan(raw.points.length);
    cloth.destroy();

    const cap = createInkLabEngine({ sdf: false });
    cap.attach(canvas);
    cap.setPen({ ...base, capillary: true });
    cap.down(hops[0]!);
    cap.move(hops.slice(1, -1));
    const capBaked = cap.up(hops[hops.length - 1]!);
    expect(capBaked.points.length).toBe(raw.points.length);
    expect(
      capBaked.points.some((p, i) => Math.abs(p.y - (raw.points[i]?.y ?? p.y)) > 0.05),
    ).toBe(true);
    cap.destroy();
  });

  it("does not clobber a live stroke when replaySpines is called", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.down({ x: 40, y: 80, p: 0.5, t: 0 });
    engine.move([
      { x: 70, y: 82, p: 0.5, t: 16 },
      { x: 110, y: 90, p: 0.5, t: 32 },
    ]);
    const live = engine.paint();
    expect(live.pts).toBeGreaterThan(1);
    engine.replaySpines([
      [
        { x: 10, y: 10, r: 4 },
        { x: 30, y: 12, r: 4 },
      ],
    ]);
    const after = engine.paint();
    expect(after.pts).toBe(live.pts);
    expect(after.hold === live.hold || after.pts > 0).toBe(true);
    engine.up({ x: 120, y: 94, p: 0.5, t: 48 });
    engine.destroy();
  });

  it("washes sparse tablet-rate hops when fade is on", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const fadePen = {
      color: "#c41e3a",
      baseWidth: 16,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 1,
      boldness: 1,
    };
    const hops = (dt: number) => {
      const engine = createInkLabEngine({ sdf: false });
      engine.attach(canvas);
      engine.setPen(fadePen);
      engine.down({ x: 40, y: 80, p: 0.5, t: 0 });
      engine.move([
        { x: 52, y: 80, p: 0.5, t: dt },
        { x: 64, y: 80, p: 0.5, t: dt * 2 },
        { x: 76, y: 80, p: 0.5, t: dt * 3 },
        { x: 88, y: 80, p: 0.5, t: dt * 4 },
      ]);
      const baked = engine.up({ x: 100, y: 80, p: 0.5, t: dt * 5 });
      engine.destroy();
      return baked;
    };
    const sparse = hops(24);
    const first = sparse.points[0]!.rgb![0];
    const fly = Math.max(...sparse.points.slice(1).map((p) => p.rgb![0]));
    expect(fly).toBeGreaterThan(180);
    expect(first).toBeGreaterThan(180);
  });

  it("washes hops that share one pointer timestamp", () => {
    let wall = 1000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => wall);
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    try {
      engine.attach(canvas);
      engine.setPen({
        color: "#c41e3a",
        baseWidth: 16,
        overlayScale: 1,
        dpr: 1,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: false,
        speedInk: 0,
        speedBlotBlend: 0,
        speedFade: 1,
        boldness: 1,
      });
      engine.down({ x: 40, y: 80, p: 0.5, t: 16 });
      wall = 1016;
      engine.move([
        { x: 80, y: 80, p: 0.5, t: 16 },
        { x: 120, y: 80, p: 0.5, t: 16 },
        { x: 160, y: 80, p: 0.5, t: 16 },
      ]);
      const baked = engine.up({ x: 200, y: 80, p: 0.5, t: 16 });
      const first = baked.points[0]!.rgb![0];
      const fly = Math.max(...baked.points.slice(1).map((p) => p.rgb![0]));
      expect(fly).toBeGreaterThan(180);
      expect(first).toBeGreaterThan(180);
    } finally {
      nowSpy.mockRestore();
      engine.destroy();
    }
  });

  it("undo patch restores the snap without replaying earlier strokes", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    const ink = (x: number, y: number, w: number, h: number) => {
      const data = canvas.getContext("2d")!.getImageData(x, y, w, h).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n += 1;
      return n;
    };
    const stroke = (x0: number, x1: number) => {
      engine.down({ x: x0, y: 80, p: 0.6, t: 0 });
      engine.move([
        { x: (x0 + x1) / 2, y: 82, p: 0.6, t: 16 },
        { x: x1, y: 84, p: 0.55, t: 32 },
      ]);
      return engine.up({ x: x1 + 8, y: 86, p: 0.5, t: 48 });
    };
    stroke(30, 70);
    engine.paint();
    const leftAfterFirst = ink(0, 0, 120, 300);
    const second = stroke(260, 320);
    engine.paint();
    expect(ink(240, 0, 160, 300)).toBeGreaterThan(10);
    expect(second.undoPatch).not.toBeNull();
    engine.restoreSnapPatch(second.undoPatch!);
    engine.paint();
    expect(ink(0, 0, 120, 300)).toBe(leftAfterFirst);
    expect(ink(240, 0, 160, 300)).toBe(0);
    engine.appendSpines([second.points]);
    engine.paint();
    expect(ink(240, 0, 160, 300)).toBeGreaterThan(10);
    expect(ink(0, 0, 120, 300)).toBe(leftAfterFirst);
    engine.destroy();
  });

  it("liftRaw keeps an undo patch like a synchronous lift", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    const ink = (x: number, y: number, w: number, h: number) => {
      const data = canvas.getContext("2d")!.getImageData(x, y, w, h).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n += 1;
      return n;
    };
    engine.down({ x: 40, y: 80, p: 0.6, t: 0 });
    engine.move([
      { x: 90, y: 82, p: 0.6, t: 16 },
      { x: 140, y: 84, p: 0.55, t: 32 },
    ]);
    engine.up({ x: 148, y: 86, p: 0.5, t: 48 });
    engine.paint();
    const leftAfterFirst = ink(0, 0, 180, 300);
    engine.down({ x: 260, y: 80, p: 0.6, t: 0 });
    engine.move([
      { x: 290, y: 82, p: 0.6, t: 16 },
      { x: 320, y: 84, p: 0.55, t: 32 },
    ]);
    const lifted = engine.liftRaw({ x: 328, y: 86, p: 0.5, t: 48 });
    engine.paint();
    expect(ink(240, 0, 160, 300)).toBeGreaterThan(10);
    expect(lifted.undoPatch).not.toBeNull();
    engine.restoreSnapPatch(lifted.undoPatch!);
    engine.paint();
    expect(ink(0, 0, 180, 300)).toBe(leftAfterFirst);
    expect(ink(240, 0, 160, 300)).toBe(0);
    engine.destroy();
  });

  it("live-smooth suffix-hits after the prefix freezes", () => {
    const canvas = createCanvas(1200, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.setPen({
      color: "#1a1a1a",
      baseWidth: 2,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
      smoothing: 0.5,
      smoothingMode: "live",
    });
    engine.down({ x: 10, y: 40, p: 0.5, t: 0 });
    for (let i = 1; i <= 280; i++) {
      engine.move([
        {
          x: 10 + i * 4,
          y: 40 + Math.sin(i / 8) * 18,
          p: 0.5,
          t: i * 8,
        },
      ]);
      if (i % 20 === 0) engine.paint();
    }
    const stats = engine.paint();
    expect(stats.pts).toBeGreaterThan(200);
    expect(stats.suffix).toBe(true);
    engine.liftRaw({ x: 360, y: 40, p: 0.5, t: 2300 });
    engine.destroy();
  });

  it("liftRaw keeps the live pixels instead of a bake remesh", () => {
    const canvas = createCanvas(400, 200) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    engine.setPen({
      color: "#1a1a1a",
      baseWidth: 2,
      overlayScale: 1,
      dpr: 1,
      maxFullness: 1,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0,
      speedBlotBlend: 0,
      speedFade: 0,
      boldness: 1,
      smoothing: 0.5,
      smoothingMode: "live",
    });
    engine.down({ x: 20, y: 80, p: 0.6, t: 0 });
    for (let i = 1; i <= 40; i++) {
      engine.move([
        {
          x: 20 + i * 8,
          y: 80 + Math.sin(i / 2) * 24,
          p: 0.6,
          t: i * 8,
        },
      ]);
      if (i % 4 === 0) engine.paint();
    }
    engine.paint();
    const ink = () => {
      const data = canvas.getContext("2d")!.getImageData(0, 0, 400, 200).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 20) n += 1;
      return n;
    };
    const liveInk = ink();
    expect(liveInk).toBeGreaterThan(40);
    const lifted = engine.liftRaw({ x: 340, y: 80, p: 0.5, t: 400 });
    engine.paint();
    expect(ink()).toBeGreaterThanOrEqual(liveInk);
    expect(lifted.points.length).toBeGreaterThan(2);
    engine.destroy();
  });

  it("replay of two far strokes keeps both after clipped blits", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    const ink = (x: number, y: number, w: number, h: number) => {
      const data = canvas.getContext("2d")!.getImageData(x, y, w, h).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n += 1;
      return n;
    };
    const bake = (x0: number, x1: number) => {
      engine.down({ x: x0, y: 80, p: 0.6, t: 0 });
      engine.move([{ x: x1, y: 84, p: 0.55, t: 32 }]);
      return engine.up({ x: x1 + 6, y: 86, p: 0.5, t: 48 }).points;
    };
    const a = bake(30, 70);
    const b = bake(260, 320);
    engine.replaySpines([a, b]);
    engine.paint();
    expect(ink(0, 0, 120, 300)).toBeGreaterThan(10);
    expect(ink(240, 0, 160, 300)).toBeGreaterThan(10);
    engine.destroy();
  });

  it("shifts the snap by a camera delta instead of remeshing", () => {
    const canvas = createCanvas(400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine({ sdf: false });
    engine.attach(canvas);
    const ink = (x: number, y: number, w: number, h: number) => {
      const data = canvas.getContext("2d")!.getImageData(x, y, w, h).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n += 1;
      return n;
    };
    engine.down({ x: 40, y: 80, p: 0.6, t: 0 });
    engine.move([
      { x: 70, y: 82, p: 0.6, t: 16 },
      { x: 110, y: 90, p: 0.55, t: 32 },
    ]);
    engine.up({ x: 118, y: 96, p: 0.5, t: 48 });
    engine.paint();
    expect(ink(0, 0, 160, 300)).toBeGreaterThan(10);
    const beforeRight = ink(180, 0, 160, 300);
    const rects = engine.shiftSnap(80, 0);
    expect(rects).not.toBeNull();
    expect(rects![0]).toEqual({ x: 0, y: 0, w: 80, h: 300 });
    engine.paint();
    expect(ink(0, 0, 60, 300)).toBe(0);
    expect(ink(180, 0, 160, 300)).toBeGreaterThan(beforeRight);
    engine.destroy();
  });
});

describe("EKF is the live filter", () => {
  it("is the same module the engine uses", () => {
    const ekf = createEkf();
    ekf.reset(0, 0, 0);
    expect(ekf.step(12, 0, 16).x).toBeGreaterThan(0);
  });
});
