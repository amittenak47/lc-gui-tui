import { describe, expect, it } from "vitest";

import { createInkLabEngine } from "./engine";

describe("createInkLabEngine", () => {
  it("returns canvas2d when webgl2 is missing", () => {
    const canvas = {
      getContext(kind: string) {
        if (kind === "webgl2") return null;
        return {
          clearRect() {},
        };
      },
    } as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine();
    expect(engine.attach(canvas)).toBe("canvas2d");
    expect(engine.attach(canvas)).toBe("canvas2d");
    expect(engine.up({ x: 0, y: 0, p: 0.5, t: 0 }).bake).toBe("catmull");
    engine.destroy();
  });
});
