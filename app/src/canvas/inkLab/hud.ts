/**
 * Ink lab overlay HUD. Board performance overlay uses this readout.
 */

export type InkLabHud = {
  backend: string;
  paints: number;
  frameMs: number;
  rafMs: number;
  pts: number;
  segs: number;
  ekfMs: number;
  drawMs: number;
  hold: boolean;
  suffix: boolean;
  bakeMs: number;
  bake: string;
};

export const INK_LAB_HUD_ZERO: InkLabHud = {
  backend: "none",
  paints: 0,
  frameMs: 0,
  rafMs: 0,
  pts: 0,
  segs: 0,
  ekfMs: 0,
  drawMs: 0,
  hold: false,
  suffix: true,
  bakeMs: 0,
  bake: "catmull",
};

export function formatInkLabHud(hud: InkLabHud): string {
  return (
    `ink lab\n` +
    `backend ${hud.backend}\n` +
    `paints ${hud.paints}\n` +
    `frame ${hud.frameMs.toFixed(1)}ms\n` +
    `raf ${hud.rafMs.toFixed(1)}ms\n` +
    `pts ${hud.pts}\n` +
    `segs ${hud.segs}\n` +
    `ekf ${hud.ekfMs.toFixed(2)}ms\n` +
    `draw ${hud.drawMs.toFixed(2)}ms\n` +
    `hold ${hud.hold ? "yes" : "no"}\n` +
    `suffix ${hud.suffix ? "hit" : "miss"}\n` +
    `bake ${hud.bakeMs.toFixed(1)}ms ${hud.bake}`
  );
}
