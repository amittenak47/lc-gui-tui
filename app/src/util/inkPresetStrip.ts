/**
 * Fixed polyline for the 1D preset test strip.
 * Scene points stay constant; only the ink knobs change.
 */

import type { InkDrawOp, ScenePoint } from "../canvas/rasterInk";
import { isEraserWedge, type InkPresetKind, type InkWedgeSnapshot } from "./inkToolPresets";

export const TEST_STRIP_POINTS: ScenePoint[] = Array.from({ length: 48 }, (_, i) => {
  const t = i / 47;
  const wave = Math.sin(t * Math.PI * 2.2);
  return {
    x: 24 + t * 420,
    y: 44 + wave * 18,
    pressure: 0.7,
    slowness: 0.5 + 0.35 * wave,
  };
});

/** Paint op for the static strip or a live preview stroke. Uses the draft snap, not live keys. */
export function drawOpFromSnap(
  kind: InkPresetKind,
  snap: InkWedgeSnapshot,
  points: readonly ScenePoint[],
): InkDrawOp | null {
  if (kind === "eraser" || isEraserWedge(snap)) return null;
  return {
    kind: "draw",
    color: snap.colour,
    baseWidth: snap.width,
    maxFullness: snap.pressureSensitive ? Math.min(snap.fullness, 0.999) : 1,
    pressureClip: snap.pressureClip,
    pressureSensitive: snap.pressureSensitive,
    speedInk: snap.speed,
    speedBlotBlend: snap.blot,
    speedFade: snap.fade,
    boldness: snap.boldness,
    highlight: kind === "highlighter",
    points: points.slice(),
  };
}

export function testStripDrawOp(
  kind: InkPresetKind,
  snap: InkWedgeSnapshot,
): InkDrawOp | null {
  return drawOpFromSnap(kind, snap, TEST_STRIP_POINTS);
}
