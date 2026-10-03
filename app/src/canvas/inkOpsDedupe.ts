/**
 * Exact duplicate strokes: one mark stored more than once.
 *
 * Keeping both sides of a merged page concatenated the two stroke lists. The
 * sides usually share most of their strokes, so every such merge doubled
 * them; a book merged a few times held each stroke about eighty times over,
 * and painting it took minutes. Real pen input never repeats a stroke point
 * for point, so a copy that matches on kind, colour, width and every point is
 * the same mark, and drawing it once changes nothing on the page.
 *
 * Fingerprints are two 32-bit hashes over the numbers, cached per op object,
 * so rebuilding a deduplicated list after one new stroke is a pass of map
 * lookups. A fingerprint match is confirmed point by point before an op is
 * treated as a copy.
 */

import type { InkOp } from "./rasterInk";

const fingerprints = new WeakMap<InkOp, string>();
const view = new DataView(new ArrayBuffer(8));

function mix(h: number, value: number): number {
  // Hash the float's bits, so 0.1 and 0.10000001 stay different marks.
  view.setFloat64(0, value);
  h = Math.imul(h ^ view.getUint32(0), 0x01000193);
  return Math.imul(h ^ view.getUint32(4), 0x01000193);
}

/** What makes two ops the same mark. Ids are left out: devices mint them independently. */
export function inkOpFingerprint(op: InkOp): string {
  const known = fingerprints.get(op);
  if (known !== undefined) return known;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const p of op.points) {
    a = mix(a, p.x);
    a = mix(a, p.y);
    b = mix(b, p.pressure);
    b = mix(b, p.x + p.y * 0.5);
  }
  const head = op.kind === "draw"
    ? `d|${op.color}|${op.baseWidth}|${op.highlight ? 1 : 0}|${op.maxFullness}|${op.pressureSensitive ? 1 : 0}`
    : `e|${op.radius}`;
  const key = `${head}|${op.points.length}|${a >>> 0}|${b >>> 0}`;
  fingerprints.set(op, key);
  return key;
}

function samePoints(a: InkOp, b: InkOp): boolean {
  if (a.points.length !== b.points.length) return false;
  for (let i = 0; i < a.points.length; i++) {
    const p = a.points[i]!;
    const q = b.points[i]!;
    if (p.x !== q.x || p.y !== q.y || p.pressure !== q.pressure) return false;
  }
  return true;
}

function visit(ops: readonly InkOp[], onCopy: (op: InkOp) => void, onKeep: (op: InkOp) => void): void {
  const seen = new Map<string, InkOp[]>();
  for (const op of ops) {
    const key = inkOpFingerprint(op);
    const twins = seen.get(key);
    if (twins?.some((twin) => samePoints(twin, op))) {
      onCopy(op);
      continue;
    }
    if (twins) twins.push(op);
    else seen.set(key, [op]);
    onKeep(op);
  }
}

/** `ops` without later exact copies of an earlier op, in order. */
export function dedupeInkOps(ops: readonly InkOp[]): InkOp[] {
  const out: InkOp[] = [];
  visit(ops, () => {}, (op) => out.push(op));
  return out.length === ops.length ? ops.slice() : out;
}

/** How many ops (and points) are exact copies of an earlier one. */
export function countInkOpDuplicates(ops: readonly InkOp[]): { ops: number; points: number } {
  let dupOps = 0;
  let dupPoints = 0;
  visit(ops, (op) => { dupOps += 1; dupPoints += op.points.length; }, () => {});
  return { ops: dupOps, points: dupPoints };
}
