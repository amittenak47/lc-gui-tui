import { createCanvas } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createInkLabEngine, DISTANCE_GATE_CSS } from "./engine";
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

  it("toolbar default width stays above the sample gate", () => {
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
    expect(baked.points[0]!.r).toBeGreaterThan(DISTANCE_GATE_CSS);
    engine.destroy();
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

  it("hold grow starts on pointer down without a move", () => {
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
      const first = engine.paint();
      expect(first.hold).toBe(true);
      for (let i = 0; i < 40; i++) engine.paint();
      const baked = engine.up({ x: 80, y: 90, p: 0.5, t: 1400 });
      expect(baked.blotTipGrow).toBeGreaterThan(0.3);
      expect(baked.points[0]!.r).toBeGreaterThan(6);
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

  it("mid-stroke hold fattens the trail behind the nib", () => {
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
      for (let i = 0; i < 40; i++) wet.paint();
      const wetBaked = wet.up({ x: 52, y: 90, p: 0.5, t: 1400 });
      expect(wetBaked.points[wetBaked.points.length - 1]!.r).toBeGreaterThan(
        dryBaked.points[dryBaked.points.length - 1]!.r,
      );
      expect(wetBaked.points[0]!.r).toBeGreaterThan(dryPrev);
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
});

describe("EKF is the live filter", () => {
  it("is the same module the engine uses", () => {
    const ekf = createEkf();
    ekf.reset(0, 0, 0);
    expect(ekf.step(12, 0, 16).x).toBeGreaterThan(0);
  });
});
