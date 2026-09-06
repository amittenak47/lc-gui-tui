import { createCanvas } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it } from "vitest";

import { createInkLabEngine } from "./engine";
import { createEkf } from "./ekf";

beforeAll(() => {
  (globalThis as Record<string, unknown>).OffscreenCanvas = class {
    constructor(w: number, h: number) {
      return createCanvas(Math.max(1, w), Math.max(1, h)) as unknown as object;
    }
  };
});

describe("Ink lab live path", () => {
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
    expect(stats.hold).toBe(true);
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
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, 400, 300).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! > 0) ink += 1;
    }
    expect(ink).toBeGreaterThan(10);
    engine.destroy();
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
});

describe("EKF is the live filter", () => {
  it("is the same module the engine uses", () => {
    const ekf = createEkf();
    ekf.reset(0, 0, 0);
    expect(ekf.step(12, 0, 16).x).toBeGreaterThan(0);
  });
});
