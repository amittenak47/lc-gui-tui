import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createInkLabEngine } from "./engine";

describe("createInkLabEngine", () => {
  it("does not import Excalidraw", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "engine.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*excalidraw/i);
  });

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
    expect(engine.up({ x: 0, y: 0, p: 0.5, t: 0 }).bake).toBe("catmull");
    engine.destroy();
  });
});
