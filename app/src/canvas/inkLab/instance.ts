/** One round-cone instance. CPU append, GPU instanced draw. */

export const INSTANCE_FLOATS = 12;

export type SpineDot = {
  x: number;
  y: number;
  r: number;
  rgb?: [number, number, number];
};

export function writeInstance(
  data: Float32Array,
  index: number,
  a: SpineDot,
  b: SpineDot,
  c0: readonly [number, number, number],
  c1: readonly [number, number, number],
): void {
  const o = index * INSTANCE_FLOATS;
  data[o] = a.x;
  data[o + 1] = a.y;
  data[o + 2] = a.r;
  data[o + 3] = b.x;
  data[o + 4] = b.y;
  data[o + 5] = b.r;
  data[o + 6] = c0[0];
  data[o + 7] = c0[1];
  data[o + 8] = c0[2];
  data[o + 9] = c1[0];
  data[o + 10] = c1[1];
  data[o + 11] = c1[2];
}

export type StrokeAabb = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export function expandAabb(box: StrokeAabb, p: SpineDot): void {
  const r = p.r + 2;
  box.minX = Math.min(box.minX, p.x - r);
  box.minY = Math.min(box.minY, p.y - r);
  box.maxX = Math.max(box.maxX, p.x + r);
  box.maxY = Math.max(box.maxY, p.y + r);
}

export function emptyAabb(): StrokeAabb {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}
