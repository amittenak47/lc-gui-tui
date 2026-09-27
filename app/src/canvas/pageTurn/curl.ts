/**
 * The geometry of a sheet being turned, in the sheet's own coordinates.
 *
 * A sheet of width `w` and height `h` is hinged along its left edge (u = 0),
 * the binding. Turning it lifts one free corner — the bottom one when the
 * finger took the lower half, the top one otherwise — and that corner follows
 * the finger. Everything else falls out of one line: the fold, which is the
 * perpendicular bisector of the corner's rest position and where it is now.
 * Paper on the corner's side of the fold is the flap, lying reflected across
 * the fold; the rest still lies flat.
 *
 * This is the 2D page curl readers have used for years. It is not a physical
 * simulation, but with shading along the fold it reads as a floppy sheet, and
 * it costs one clip and one transform per frame.
 */

export interface Point {
  x: number;
  y: number;
}

export interface CurlGeometry {
  /** Where the lifted corner is drawn. */
  corner: Point;
  /** Where it rests when the sheet is flat. */
  rest: Point;
  /** A point on the fold and the fold's unit direction. */
  foldPoint: Point;
  foldDir: Point;
  /** Unit normal of the fold, pointing toward the flap (the corner's rest side). */
  foldNormal: Point;
  /** 0 flat, 1 fully over. */
  progress: number;
}

/**
 * Keep the corner where paper bound at the spine can actually reach.
 *
 * The lifted corner stays within a sheet's width of the spine corner on its
 * own edge, and within the diagonal of the other spine corner. Without this
 * the flap stretches and tears away from the binding.
 */
export function constrainCorner(corner: Point, w: number, h: number, bottom: boolean): Point {
  let p = { ...corner };
  const near = { x: 0, y: bottom ? h : 0 };
  const far = { x: 0, y: bottom ? 0 : h };
  const nearDist = Math.hypot(p.x - near.x, p.y - near.y);
  if (nearDist > w) {
    p = { x: near.x + ((p.x - near.x) / nearDist) * w, y: near.y + ((p.y - near.y) / nearDist) * w };
  }
  const diag = Math.hypot(w, h);
  const farDist = Math.hypot(p.x - far.x, p.y - far.y);
  if (farDist > diag) {
    p = { x: far.x + ((p.x - far.x) / farDist) * diag, y: far.y + ((p.y - far.y) / farDist) * diag };
  }
  return p;
}

export function curlGeometry(corner: Point, w: number, h: number, bottom: boolean): CurlGeometry {
  const rest = { x: w, y: bottom ? h : 0 };
  const p = constrainCorner(corner, w, h, bottom);
  const dx = rest.x - p.x;
  const dy = rest.y - p.y;
  const len = Math.hypot(dx, dy);
  const foldPoint = { x: (rest.x + p.x) / 2, y: (rest.y + p.y) / 2 };
  // Flat: the fold sits on the free edge with nothing folded.
  const foldNormal = len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
  const foldDir = { x: -foldNormal.y, y: foldNormal.x };
  const progress = Math.min(1, Math.max(0, (w - p.x) / (2 * w)));
  return { corner: p, rest, foldPoint, foldDir, foldNormal, progress };
}

/** Signed distance of a point from the fold; positive on the flap side. */
export function foldSide(g: CurlGeometry, pt: Point): number {
  return (pt.x - g.foldPoint.x) * g.foldNormal.x + (pt.y - g.foldPoint.y) * g.foldNormal.y;
}

/**
 * The reflection across the fold as a canvas transform (a, b, c, d, e, f).
 *
 * Applied on top of the sheet's own placement, it takes a point of the flat
 * sheet to where it lies once folded over.
 */
export function foldReflection(g: CurlGeometry): [number, number, number, number, number, number] {
  const { x: nx, y: ny } = g.foldNormal;
  const a = 1 - 2 * nx * nx;
  const b = -2 * nx * ny;
  const c = -2 * nx * ny;
  const d = 1 - 2 * ny * ny;
  // Reflect about a line through foldPoint: x' = M(x - p) + p.
  const { x: px, y: py } = g.foldPoint;
  const e = px - (a * px + c * py);
  const f = py - (b * px + d * py);
  return [a, b, c, d, e, f];
}

/**
 * The polygon of the sheet on one side of the fold, in sheet coordinates.
 *
 * `flap` picks the folded part; otherwise the part still lying flat.
 */
export function sheetPart(g: CurlGeometry, w: number, h: number, flap: boolean): Point[] {
  const corners = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  const keep = (pt: Point) => (flap ? foldSide(g, pt) > 0 : foldSide(g, pt) <= 0);
  const out: Point[] = [];
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    const sa = foldSide(g, a);
    const sb = foldSide(g, b);
    if (keep(a)) out.push(a);
    if ((sa > 0) !== (sb > 0)) {
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/**
 * Where the corner is for a drag of `dx` pixels.
 *
 * Twice the drag, so pulling across half the sheet turns it all the way, and
 * a turn does not have to start at the very edge. A backward turn is the same
 * sheet coming back from fully over, so it starts at `-w`.
 */
export function cornerForDrag(
  direction: "next" | "prev",
  dx: number,
  dy: number,
  w: number,
  h: number,
  bottom: boolean,
): Point {
  const baseX = direction === "next" ? w : -w;
  const x = Math.min(w, Math.max(-w, baseX + 2 * dx));
  const y = (bottom ? h : 0) + dy * 0.5;
  return { x, y };
}

/** Whether letting go here finishes the turn: past halfway, the sheet goes over. */
export function turnCommits(direction: "next" | "prev", cornerX: number): boolean {
  return direction === "next" ? cornerX < 0 : cornerX > 0;
}
