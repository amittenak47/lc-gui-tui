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
 * Twice the drag, so the fold moves with the finger — the finger holds the
 * crease — and pulling across the sheet turns it all the way. A backward turn
 * is the same sheet coming back from fully over, so it starts at `-w`.
 *
 * `lift` peels the corner a little before the finger has moved at all: the
 * page shows it is held the moment it is touched.
 */
export function cornerForDrag(
  direction: "next" | "prev",
  dx: number,
  dy: number,
  w: number,
  h: number,
  bottom: boolean,
  lift = 0,
): Point {
  const baseX = direction === "next" ? w - lift : -w + lift;
  const x = Math.min(w, Math.max(-w, baseX + 2 * dx));
  const y = (bottom ? h - lift * 0.6 : lift * 0.6) + dy * 0.5;
  return { x, y };
}

/** How far a let-go sheet must have turned to go over; short of it, it unravels. */
export const TURN_COMMIT_PROGRESS = 0.35;
/** Most a throw may add to how far the sheet has turned. */
const THROW_MAX_PROGRESS = 0.25;

/** How far the sheet is through its turn: 0 where it started, 1 over. */
export function turnProgress(direction: "next" | "prev", cornerX: number, w: number): number {
  if (!(w > 0)) return 0;
  const p = direction === "next" ? (w - cornerX) / (2 * w) : (cornerX + w) / (2 * w);
  return Math.min(1, Math.max(0, p));
}

/**
 * Whether letting go here finishes the turn.
 *
 * Past {@link TURN_COMMIT_PROGRESS} the sheet goes over; short of it, it
 * settles back. `throwPx` is how much further the hand was carrying the
 * crease along the turn when it let go — a flick counts for where it was
 * going, up to a limit, so a twitch at the corner is still not a turn.
 */
export function turnCommits(direction: "next" | "prev", cornerX: number, w: number, throwPx = 0): boolean {
  const thrown = w > 0 ? Math.min(THROW_MAX_PROGRESS, Math.max(-1, throwPx / w)) : 0;
  return turnProgress(direction, cornerX, w) + thrown >= TURN_COMMIT_PROGRESS;
}
