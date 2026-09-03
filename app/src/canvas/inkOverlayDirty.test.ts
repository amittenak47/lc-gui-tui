import { describe, expect, it, beforeAll } from "vitest";
import { createCanvas } from "@napi-rs/canvas";

import {
  applyInkOp,
  debugRibbonScratchSize,
  releaseLiveRibbonBuffers,
  type ScenePoint,
} from "./rasterInk";
import { beginLiveStroke } from "./liveStroke";
import { INK_SMOOTHING_MODE_DEFAULT } from "./inkSmoothing";

beforeAll(() => {
  (globalThis as Record<string, unknown>).OffscreenCanvas = class {
    constructor(w: number, h: number) {
      return createCanvas(Math.max(1, w), Math.max(1, h)) as unknown as object;
    }
  };
});

function rect(): DOMRectReadOnly {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 200,
    width: 200,
    height: 200,
    toJSON() {
      return {};
    },
  };
}

function view() {
  return {
    zoom: 1,
    scrollX: 0,
    scrollY: 0,
    offsetLeft: 0,
    offsetTop: 0,
    width: 200,
    height: 200,
  };
}

describe("live overlay dirty restore", () => {
  it("does not leave live ink outside the dirty rect", () => {
    const overlay = createCanvas(200, 200);
    const snap = createCanvas(200, 200);
    const octx = overlay.getContext("2d");
    const sctx = snap.getContext("2d");
    octx.fillStyle = "#e8e4d4";
    octx.fillRect(0, 0, 200, 200);
    sctx.drawImage(overlay as unknown as CanvasImageSource, 0, 0);

    const stroke = beginLiveStroke({
      tool: "pen",
      view: view(),
      rect: rect(),
      box: { width: 200, height: 200, marginY: 0 },
      first: {
        clientX: 20,
        clientY: 20,
        pressure: 0.5,
        timeStamp: 1000,
        pointerType: "pen",
      },
      color: "#1a4fd8",
      uiWidth: 4,
      inkFullness: 0.8,
      pressureClip: 1,
      pressureSensitive: false,
      speedInk: 0.6,
      speedBlotBlend: 0.9,
      speedFade: 0.4,
      grain: 0,
      boldness: 1,
      smoothing: 0,
      smoothingMode: INK_SMOOTHING_MODE_DEFAULT,
      getStraightAnchor: () => null,
      host: null,
      onNeedPaint: () => {},
    });
    stroke.ingest([
      {
        clientX: 50,
        clientY: 22,
        pressure: 0.5,
        timeStamp: 1080,
        pointerType: "pen",
      },
    ]);
    stroke.tick(1080);
    const result = stroke.paint(
      octx as unknown as CanvasRenderingContext2D,
      overlay as unknown as HTMLCanvasElement,
      1,
      null,
      new Map(),
      snap as unknown as HTMLCanvasElement,
    );
    expect(result).toBe("ok");

    const far = octx.getImageData(180, 180, 1, 1).data;
    const snapFar = sctx.getImageData(180, 180, 1, 1).data;
    expect([far[0], far[1], far[2], far[3]]).toEqual([
      snapFar[0],
      snapFar[1],
      snapFar[2],
      snapFar[3],
    ]);
    stroke.abandon();
  });
});

describe("ribbon scratch release", () => {
  it("a short stroke after a long one does not keep the huge backing", () => {
    releaseLiveRibbonBuffers();
    const canvas = createCanvas(900, 500);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    const long: ScenePoint[] = [];
    for (let i = 0; i < 80; i++) {
      long.push({ x: 40 + i * 8, y: 80 + Math.sin(i / 6) * 40, pressure: 0.5, slowness: 1 });
    }
    applyInkOp(
      ctx,
      {
        kind: "draw",
        color: "#c41e3a",
        baseWidth: 5,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: true,
        speedInk: 0.6,
        speedBlotBlend: 0.9,
        speedFade: 0.4,
        points: long,
      },
      1,
    );
    const big = debugRibbonScratchSize();
    expect(big).not.toBeNull();
    releaseLiveRibbonBuffers();
    expect(debugRibbonScratchSize()).toBeNull();

    applyInkOp(
      ctx,
      {
        kind: "draw",
        color: "#c41e3a",
        baseWidth: 5,
        maxFullness: 1,
        pressureClip: 1,
        pressureSensitive: true,
        speedInk: 0.6,
        speedBlotBlend: 0.9,
        speedFade: 0.4,
        points: [
          { x: 10, y: 10, pressure: 0.5, slowness: 1 },
          { x: 18, y: 11, pressure: 0.5, slowness: 1 },
        ],
      },
      1,
    );
    const small = debugRibbonScratchSize();
    expect(small).not.toBeNull();
    expect(small!.width * small!.height).toBeLessThan(big!.width * big!.height);
    releaseLiveRibbonBuffers();
  });
});
