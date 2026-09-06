import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import { createFallbackPainter, fillMiterStroke } from "./fallback";

describe("2D fallback", () => {
  it("does not call arc at interior joins", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fallback.ts"), "utf8");
    const loop = src.slice(src.indexOf("for (let i = 1"), src.indexOf("const head"));
    expect(loop).toContain("fillQuad");
    expect(loop).not.toContain(".arc(");
  });

  it("paints a mitered strip onto a canvas", () => {
    const canvas = createCanvas(200, 120);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    fillMiterStroke(
      ctx,
      [
        { x: 20, y: 40, r: 8 },
        { x: 80, y: 44, r: 7 },
        { x: 140, y: 50, r: 9 },
      ],
      { x: 140, y: 50, r: 9 },
      [20, 20, 20],
    );
    const data = ctx.getImageData(0, 0, 200, 120).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) ink += 1;
    expect(ink).toBeGreaterThan(50);
  });

  it("appends hops onto a scratch", () => {
    const painter = createFallbackPainter(
      (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement,
      200,
      120,
    );
    expect(painter).not.toBeNull();
    painter!.beginStroke();
    painter!.appendHop({ x: 20, y: 40, r: 8 }, { x: 80, y: 44, r: 7 }, [20, 20, 20]);
    const target = createCanvas(200, 120);
    const tctx = target.getContext("2d") as unknown as CanvasRenderingContext2D;
    painter!.blit(tctx);
    const data = tctx.getImageData(0, 0, 200, 120).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) ink += 1;
    expect(ink).toBeGreaterThan(20);
    painter!.destroy();
  });
});
