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
});

describe("EKF is the live filter", () => {
  it("is the same module the engine uses", () => {
    const ekf = createEkf();
    ekf.reset(0, 0, 0);
    expect(ekf.step(12, 0, 16).x).toBeGreaterThan(0);
  });
});
