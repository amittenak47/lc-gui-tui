import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("ink lab sources", () => {
  it("does not import Excalidraw", () => {
    const src = readFileSync(join(here, "engine.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*excalidraw/i);
  });

  it("does not call arc at interior joins", () => {
    const src = readFileSync(join(here, "fallback.ts"), "utf8");
    const loop = src.slice(src.indexOf("for (let i = from"), src.indexOf("const head"));
    expect(loop).toContain("ctx.moveTo(a.x + ax, a.y + ay)");
    expect(loop).toContain("ctx.lineTo(b.x - bx, b.y - by)");
    expect(loop).not.toContain(".arc(");
    expect(loop).not.toContain("cap(");
  });
});
