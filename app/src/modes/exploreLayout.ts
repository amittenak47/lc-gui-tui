/**
 * Where the nodes float, and how they move.
 *
 * The first Explore laid clusters on a grid, which read as a filing cabinet
 * rather than a graph: every node at a right angle to every other, and the
 * whole thing visibly recomputed when one arrived. This is a small physics
 * step instead. Nodes drift, push each other apart, and pull together when the
 * reader asks for clusters.
 *
 * Positions live in **normalized 0..1 space** and are multiplied by the
 * measured box at paint time. That is what makes the atlas survive a window
 * resize or being dropped into half a split pane: the simulation never learns
 * the pixel size, so nothing has to be recomputed when it changes.
 *
 * Deterministic seeding. A node starts where its id says it starts, so opening
 * Explore twice does not reshuffle the map you were learning.
 */

import type { NodeRef, NodeType } from "../util/noteLinks";

export interface Body {
  key: string;
  node: NodeRef;
  /** Normalized position, 0..1 on both axes. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Phase offsets so no two nodes bob in step. */
  driftX: number;
  driftY: number;
}

/** Cluster order, and where each one gathers when clustering is on. */
export const CLUSTERS: ReadonlyArray<{ type: NodeType; label: string }> = [
  { type: "annotate", label: "Notes & documents" },
  { type: "whiteboard", label: "Whiteboards" },
  { type: "practice", label: "Practice" },
  { type: "web", label: "Web" },
  { type: "thread", label: "Threads" },
];

/** FNV-1a, so a node's start is its own and never moves between sessions. */
function seedOf(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * splitmix32, over the FNV output.
 *
 * FNV alone was not enough here. Real library ids differ by a character or two
 * (`mdink-1`, `mdink-2`), and FNV maps near-inputs to near-outputs in the low
 * bits, so a whole library seeded straight from it landed in one corner. This
 * avalanches, so neighbouring ids start nowhere near each other.
 */
function mix(seed: number, salt: number): number {
  let x = (seed + salt * 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
  return ((x ^ (x >>> 15)) >>> 0) / 0xffffffff;
}

/**
 * The R2 low-discrepancy sequence.
 *
 * Straight hashing gave each node its own start, which sounds right and looked
 * wrong: six samples from a uniform distribution clump, so a small library
 * bunched into a band and left half the canvas empty. Repulsion could not fix
 * it, because the problem was where they started, not how hard they pushed.
 *
 * R2 covers the box evenly at every count. Nodes are ranked by hash rather than
 * by insertion order, so the sequence is stable for a given set: opening
 * Explore twice puts everything back where it was.
 *
 * The cost is that adding a node re-ranks the others. With the simulation
 * running they ease into the new spacing over a second or so, which reads as
 * the map making room rather than as a reshuffle.
 */
const R2_A = 0.7548776662466927;
const R2_B = 0.5698402909980532;

function r2Point(index: number): { x: number; y: number } {
  return {
    x: ((0.5 + R2_A * (index + 1)) % 1) * 0.72 + 0.14,
    y: ((0.5 + R2_B * (index + 1)) % 1) * 0.72 + 0.14,
  };
}

/** Home positions for a whole set, evenly spread and stable per set. */
function homes(keys: readonly string[]): Map<string, { x: number; y: number }> {
  const ranked = [...keys].sort((a, b) => seedOf(a) - seedOf(b) || (a < b ? -1 : 1));
  const out = new Map<string, { x: number; y: number }>();
  ranked.forEach((key, index) => out.set(key, r2Point(index)));
  return out;
}

export function makeBody(key: string, node: NodeRef, home?: { x: number; y: number }): Body {
  const seed = seedOf(key);
  const start = home ?? r2Point(seed % 97);
  return {
    key,
    node,
    x: start.x,
    y: start.y,
    vx: 0,
    vy: 0,
    driftX: mix(seed, 3) * Math.PI * 2,
    driftY: mix(seed, 4) * Math.PI * 2,
  };
}

/** Build every body for a set at once, which is what fixes the coverage. */
export function makeBodies(nodes: readonly NodeRef[], keyOf: (node: NodeRef) => string): Body[] {
  const keys = nodes.map(keyOf);
  const spots = homes(keys);
  return nodes.map((node, index) => makeBody(keys[index]!, node, spots.get(keys[index]!)));
}

/** Where a body is pulled when nothing else is acting on it. */
export function homeOf(bodies: readonly Body[], key: string): { x: number; y: number } {
  const spots = homes(bodies.map((body) => body.key));
  return spots.get(key) ?? { x: 0.5, y: 0.5 };
}

/**
 * Where each cluster gathers, spread over the box rather than at fixed points.
 *
 * Only the kinds actually present get a slot, so a library of notes and
 * whiteboards uses the whole canvas instead of huddling in the corner two
 * fixed centres happened to occupy.
 */
export function clusterCentres(
  types: readonly NodeType[],
): Map<NodeType, { x: number; y: number }> {
  const present = CLUSTERS.filter((cluster) => types.includes(cluster.type));
  const out = new Map<NodeType, { x: number; y: number }>();
  if (present.length === 0) return out;
  const cols = Math.ceil(Math.sqrt(present.length));
  const rows = Math.ceil(present.length / cols);
  present.forEach((cluster, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    // Centre a short last row rather than leaving a hole where its missing
    // cell would have been. Three kinds on a 2x2 grid otherwise park two at
    // the top and one bottom-left, with a quarter of the canvas empty.
    const inRow = Math.min(cols, present.length - row * cols);
    out.set(cluster.type, {
      x: (col + 0.5) / inRow,
      y: (row + 0.5) / rows,
    });
  });
  return out;
}

export interface StepOptions {
  /** Pull each node toward its kind's centre instead of letting it roam. */
  clustered: boolean;
  /** Seconds since the last step, clamped by the caller. */
  dt: number;
  /** Total elapsed seconds, for the drift oscillators. */
  time: number;
  /** Box aspect (w/h), so repulsion is round on screen and not on paper. */
  aspect: number;
}

/**
 * Tuned against a real library, not derived.
 *
 * The ratio that matters is repulsion against pull. Nodes have labels under
 * them, so they need roughly {@link MIN_GAP} of clear space or the captions
 * collide and the map becomes unreadable, which is worse than an uneven one.
 * Repulsion therefore has to win inside that radius and vanish outside it.
 */
const MIN_GAP = 0.18;
const REPEL = 0.6;
const HOME_PULL = 0.75;
const CLUSTER_PULL = 2.2;
const DRIFT = 0.014;
const DAMPING = 0.9;
const EDGE_PAD = 0.07;

/**
 * Advance the simulation one frame, in place.
 *
 * Deliberately not a general force-directed layout. Edges do not pull, because
 * a reader looking for one note should not have the map rearrange itself around
 * whatever else that note happens to link to. What moves things is: a gentle
 * pull home, mutual repulsion so labels stay readable, and a slow drift that
 * keeps the page from looking frozen.
 */
export function step(bodies: Body[], centres: Map<NodeType, { x: number; y: number }>, opts: StepOptions): void {
  const { clustered, dt, time, aspect } = opts;
  // One map per frame, not one per body: the ranking is over the whole set.
  const spots = homes(bodies.map((body) => body.key));
  for (const body of bodies) {
    const home = spots.get(body.key) ?? { x: 0.5, y: 0.5 };
    const target = clustered ? centres.get(body.node.type) ?? home : home;
    const pull = clustered ? CLUSTER_PULL : HOME_PULL;

    let fx = (target.x - body.x) * pull;
    let fy = (target.y - body.y) * pull;

    // A slow wander, so a static graph still breathes. Two incommensurate
    // frequencies keep it from reading as a loop.
    fx += Math.sin(time * 0.31 + body.driftX) * DRIFT;
    fy += Math.cos(time * 0.23 + body.driftY) * DRIFT;

    for (const other of bodies) {
      if (other === body) continue;
      /*
       * Measured in screen proportions, not paper ones.
       *
       * A wide pane squashes normalized x, so two nodes a comfortable distance
       * apart on paper can be touching on screen. Scaling x by the aspect makes
       * the spacing round where the reader is looking.
       */
      const dx = (body.x - other.x) * aspect;
      const dy = body.y - other.y;
      let dist = Math.hypot(dx, dy);
      if (dist > MIN_GAP) continue;
      // Two nodes at exactly the same point have no direction to separate in.
      // Nudge along a fixed diagonal rather than picking a random one, which
      // would make the layout non-deterministic.
      const ux = dist < 1e-5 ? 0.7071 : dx / dist;
      const uy = dist < 1e-5 ? 0.7071 : dy / dist;
      if (dist < 1e-5) dist = 1e-5;
      // Linear falloff to zero at MIN_GAP: strong when overlapping, absent
      // once they are comfortable, so it never fights the pull at long range.
      const push = REPEL * (1 - dist / MIN_GAP);
      fx += (ux * push) / aspect;
      fy += uy * push;
    }

    body.vx = (body.vx + fx * dt) * DAMPING;
    body.vy = (body.vy + fy * dt) * DAMPING;
    body.x += body.vx * dt;
    body.y += body.vy * dt;

    // Keep everything on the page. Bounce rather than clamp, so a node pushed
    // into the wall drifts back instead of sticking to it.
    if (body.x < EDGE_PAD) {
      body.x = EDGE_PAD;
      body.vx = Math.abs(body.vx) * 0.4;
    } else if (body.x > 1 - EDGE_PAD) {
      body.x = 1 - EDGE_PAD;
      body.vx = -Math.abs(body.vx) * 0.4;
    }
    if (body.y < EDGE_PAD) {
      body.y = EDGE_PAD;
      body.vy = Math.abs(body.vy) * 0.4;
    } else if (body.y > 1 - EDGE_PAD) {
      body.y = 1 - EDGE_PAD;
      body.vy = -Math.abs(body.vy) * 0.4;
    }
  }
}

/**
 * Run the simulation to a resting state without painting it.
 *
 * For the first frame, and for readers who asked for reduced motion. Without
 * this the atlas would visibly fly apart from its seed positions on open.
 */
export function settle(
  bodies: Body[],
  centres: Map<NodeType, { x: number; y: number }>,
  clustered: boolean,
  aspect = 1.6,
  frames = 240,
): void {
  for (let i = 0; i < frames; i += 1) {
    step(bodies, centres, { clustered, dt: 1 / 60, time: 0, aspect });
  }
}

/** Label anchor for a cluster: above the highest of its members. */
export function clusterLabels(
  bodies: readonly Body[],
): Array<{ type: NodeType; label: string; x: number; y: number }> {
  return CLUSTERS.flatMap((cluster) => {
    const members = bodies.filter((body) => body.node.type === cluster.type);
    if (members.length === 0) return [];
    const xs = members.map((body) => body.x);
    return [
      {
        type: cluster.type,
        label: cluster.label,
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: Math.min(...members.map((body) => body.y)),
      },
    ];
  });
}
