import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("Board", () => {
  it("does not import or mount Excalidraw", () => {
    const src = readFileSync(join(here, "Board.tsx"), "utf8");
    expect(src).not.toMatch(/from\s+["']@excalidraw\/excalidraw["']/);
    expect(src).not.toMatch(/<Excalidraw\b/);
    expect(src).not.toMatch(/excalidraw\/index\.css/);
  });
});

describe("WhiteboardInkLab", () => {
  it("does not replay ink with the miter strip", () => {
    const src = readFileSync(join(here, "WhiteboardInkLab.tsx"), "utf8");
    expect(src).not.toMatch(/paintLabDrawOps/);
    expect(src).not.toMatch(/fillMiterStroke/);
    expect(src).not.toMatch(/inkLineWidth/);
  });

  it("maps toolbar colour, width, and hold grow onto the WebGL nib", () => {
    const src = readFileSync(join(here, "WhiteboardInkLab.tsx"), "utf8");
    expect(src).toMatch(/labPenFromToolbar/);
    expect(src).toMatch(/setPen\(/);
    expect(src).toMatch(/inkColorRef/);
    expect(src).toMatch(/strokeWidthRef/);
    expect(src).toMatch(/blotRef/);
  });
});
