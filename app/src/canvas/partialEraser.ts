/**
 * Partial spherical eraser for freedraw ink.
 *
 * Brush radius is defined in **scene units** so zooming out does not turn a thin
 * eraser into a huge blot. The on-screen preview multiplies by zoom.
 *
 * Cuts use segment–circle clipping so we keep original vertices and pressures
 * instead of densifying the stroke (densified output made light strokes thicker).
 */

export interface ErasableFreedraw {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  points?: ReadonlyArray<readonly [number, number]>;
  pressures?: readonly number[];
  simulatePressure?: boolean;
  locked?: boolean;
  isDeleted?: boolean;
  version?: number;
  versionNonce?: number;
  customData?: { lcRegion?: string; lcVizId?: string } | null;
  [key: string]: unknown;
}

interface SceneSample {
  x: number;
  y: number;
  pressure: number;
}

/** Scene-unit brush radius for Thin / Bold / Heavy (constant across zoom). */
export function eraserSceneRadius(strokeWidth: number): number {
  if (strokeWidth <= 1) return 4;
  if (strokeWidth <= 2) return 8;
  return 14;
}

/** Screen-pixel radius for the brush preview ring. */
export function eraserScreenRadius(strokeWidth: number, zoom: number): number {
  return eraserSceneRadius(strokeWidth) * Math.max(0.05, zoom);
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function shouldProtect(element: ErasableFreedraw): boolean {
  if (element.locked) return true;
  if (element.customData?.lcRegion) return true;
  if (element.customData?.lcVizId) return true;
  return false;
}

function newId(seed: string): string {
  return `lc-erase-${seed}-${Math.random().toString(36).slice(2, 9)}`;
}

function pressureAt(element: ErasableFreedraw, index: number): number {
  const value = element.pressures?.[index];
  return typeof value === "number" ? value : 0.5;
}

function absoluteSamples(element: ErasableFreedraw): SceneSample[] {
  const pts = element.points;
  if (!pts) return [];
  return pts.map((point, index) => ({
    x: element.x + point[0],
    y: element.y + point[1],
    pressure: pressureAt(element, index),
  }));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sampleAt(
  a: SceneSample,
  b: SceneSample,
  t: number,
): SceneSample {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    pressure: lerp(a.pressure, b.pressure, t),
  };
}

function nearlySame(a: SceneSample, b: SceneSample, epsilon = 0.01): boolean {
  return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

function appendSample(run: SceneSample[], sample: SceneSample): void {
  const last = run[run.length - 1];
  if (last && nearlySame(last, sample)) return;
  run.push(sample);
}

/** Parametric line–circle intersections with t in [0, 1]. */
function segmentCircleHits(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r: number,
): number[] {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return [];

  const fx = ax - cx;
  const fy = ay - cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * len2 * c;
  if (disc < 0) return [];

  const sqrtDisc = Math.sqrt(disc);
  const hits: number[] = [];
  for (const sign of [-1, 1] as const) {
    const t = (-b + sign * sqrtDisc) / (2 * len2);
    if (t >= 0 && t <= 1) hits.push(t);
  }
  hits.sort((left, right) => left - right);
  return hits;
}

/** Sub-segments of AB that lie outside the eraser circle. */
function clipSegmentOutside(
  a: SceneSample,
  b: SceneSample,
  cx: number,
  cy: number,
  r: number,
): Array<[SceneSample, SceneSample]> {
  const hits = segmentCircleHits(a.x, a.y, b.x, b.y, cx, cy, r);
  const ts = [0, ...hits, 1].filter((value, index, list) => index === 0 || value - list[index - 1] > 1e-6);
  const r2 = r * r;
  const outside: Array<[SceneSample, SceneSample]> = [];

  for (let index = 0; index < ts.length - 1; index++) {
    const t0 = ts[index];
    const t1 = ts[index + 1];
    const midT = (t0 + t1) / 2;
    const mx = lerp(a.x, b.x, midT);
    const my = lerp(a.y, b.y, midT);
    if (dist2(mx, my, cx, cy) > r2) {
      outside.push([sampleAt(a, b, t0), sampleAt(a, b, t1)]);
    }
  }

  return outside;
}

export function freedrawFromAbsolutePoints(
  source: ErasableFreedraw,
  absolute: SceneSample[],
  options: { keepId?: boolean; idSeed?: string } = {},
): ErasableFreedraw {
  if (absolute.length < 2) {
    throw new Error("freedraw needs at least two points");
  }

  const originX = absolute[0].x;
  const originY = absolute[0].y;
  const points: Array<[number, number]> = absolute.map((sample) => [
    sample.x - originX,
    sample.y - originY,
  ]);
  const pressures = absolute.map((sample) => sample.pressure);

  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (const [px, py] of points) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }

  return {
    ...source,
    id: options.keepId ? source.id : newId(options.idSeed ?? source.id),
    x: originX,
    y: originY,
    points,
    pressures,
    simulatePressure: source.simulatePressure ?? true,
    width: maxX - minX,
    height: maxY - minY,
    isDeleted: false,
    version: (typeof source.version === "number" ? source.version : 0) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
  };
}

export function eraseFreedrawAt(
  element: ErasableFreedraw,
  sceneX: number,
  sceneY: number,
  radius: number,
): ErasableFreedraw[] {
  const samples = absoluteSamples(element);
  if (samples.length < 2) {
    return element.isDeleted ? [] : [element];
  }

  const runs: SceneSample[][] = [];
  let current: SceneSample[] = [];

  const flush = () => {
    if (current.length >= 2) runs.push(current);
    current = [];
  };

  for (let index = 1; index < samples.length; index++) {
    const start = samples[index - 1];
    const end = samples[index];
    const pieces = clipSegmentOutside(start, end, sceneX, sceneY, radius);

    if (pieces.length === 0) {
      flush();
      continue;
    }

    for (const [pieceStart, pieceEnd] of pieces) {
      if (current.length === 0) {
        current.push(pieceStart);
      } else if (!nearlySame(current[current.length - 1], pieceStart)) {
        flush();
        current.push(pieceStart);
      }
      appendSample(current, pieceEnd);
    }
  }

  flush();

  if (runs.length === 0) return [];

  const unchanged =
    runs.length === 1 &&
    runs[0].length === samples.length &&
    runs[0].every(
      (sample, index) =>
        nearlySame(sample, samples[index]) &&
        Math.abs(sample.pressure - samples[index].pressure) < 0.001,
    );
  if (unchanged) return [element];

  return runs.map((run, index) =>
    freedrawFromAbsolutePoints(element, run, {
      keepId: index === 0,
      idSeed: `${element.id}-${index}`,
    }),
  );
}

export function eraseSceneAlong<T extends ErasableFreedraw>(
  elements: readonly T[],
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
): T[] | null {
  const dist = Math.hypot(toX - fromX, toY - fromY);
  const step = Math.max(radius * 0.45, 0.5);
  let current: readonly T[] = elements;
  let changed = false;

  if (dist < step) {
    return eraseSceneAt(current, toX, toY, radius);
  }

  const stamps = Math.ceil(dist / step);
  for (let index = 0; index <= stamps; index++) {
    const t = index / stamps;
    const x = fromX + (toX - fromX) * t;
    const y = fromY + (toY - fromY) * t;
    const next = eraseSceneAt(current, x, y, radius);
    if (next) {
      current = next;
      changed = true;
    }
  }

  return changed ? [...current] : null;
}

export function eraseSceneAt<T extends ErasableFreedraw>(
  elements: readonly T[],
  sceneX: number,
  sceneY: number,
  radius: number,
): T[] | null {
  let changed = false;
  const next: T[] = [];

  for (const element of elements) {
    if (element.isDeleted) {
      next.push(element);
      continue;
    }
    if (element.type !== "freedraw" || shouldProtect(element)) {
      next.push(element);
      continue;
    }

    const pieces = eraseFreedrawAt(element, sceneX, sceneY, radius);
    if (pieces.length === 1 && pieces[0] === element) {
      next.push(element);
      continue;
    }

    changed = true;
    if (pieces.length === 0) {
      next.push({
        ...element,
        isDeleted: true,
        version: (typeof element.version === "number" ? element.version : 0) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
      });
      continue;
    }

    for (const piece of pieces) {
      next.push(piece as T);
    }
  }

  return changed ? next : null;
}
