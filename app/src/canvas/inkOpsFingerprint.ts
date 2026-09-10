import type { InkOp } from "./rasterInk";

/**
 * Content key for persisted scene tiles.
 *
 * Tiles are camera-independent, so the only invalidation is the committed ops
 * (and a clip baked into the pixels). Object identity does not survive restore.
 */
export function inkOpsFingerprint(ops: readonly InkOp[], clipKey = ""): string {
  let h = 2166136261 >>> 0;
  const mix = (n: number) => {
    h ^= n >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  };
  mix(ops.length);
  for (let i = 0; i < clipKey.length; i += 1) mix(clipKey.charCodeAt(i));
  for (const op of ops) {
    mix(op.kind === "erase" ? 0x65 : 0x64);
    mix(op.points.length);
    if (op.id != null) mix(op.id | 0);
    if (op.seq != null) mix(op.seq | 0);
    if (op.kind === "draw") {
      mix((op.baseWidth * 100) | 0);
      mix((op.speedInk ?? 0) * 1000 | 0);
      mix((op.speedFade ?? 0) * 1000 | 0);
      mix((op.speedBlotBlend ?? 0) * 1000 | 0);
      const color = op.color;
      for (let i = 0; i < color.length; i += 1) mix(color.charCodeAt(i));
      if (op.highlight) mix(1);
    } else {
      mix((op.radius * 100) | 0);
    }
    const points = op.points;
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i]!;
      mix((p.x * 10) | 0);
      mix((p.y * 10) | 0);
      mix(((p.pressure ?? 0) * 1000) | 0);
    }
  }
  return (h >>> 0).toString(36);
}

export function inkClipFingerprint(
  clip: { minX: number; minY: number; maxX: number; maxY: number } | null,
): string {
  if (!clip) return "";
  return `${clip.minX | 0},${clip.minY | 0},${clip.maxX | 0},${clip.maxY | 0}`;
}
