/**
 * The board's fixed geography.
 *
 * The student writes in the left-hand regions; the coach's injected diagrams
 * land only in the **agent lane** on the right, so they can never collide with
 * handwriting. Both the templates and the viz renderers read these numbers, so
 * there is one source of truth for where anything goes.
 *
 * Exception: `highlight_student_work` overlays sit over student elements (still
 * coach-tagged via `lcVizId`) so the coach can point without mutating ink.
 */

export type RegionId =
  | "constraints"
  | "code"
  | "approach"
  | "complexity"
  | "walkthrough"
  | "agent";

export interface Region {
  id: RegionId;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Sizing note: these are canvas units, and the whole board is roughly doubled
 * from the first pass. Region size has **no effect on how the coach reads the
 * board** — capture sends each element's `{type, x, y, w, h, text}` plus the
 * `lcRegion` tag it carries, and `regionAt` derives membership from these same
 * numbers. So the layout can grow purely for legibility and elbow room.
 */
export const REGION_GUTTER = 64;
const GUTTER = REGION_GUTTER;
/** Student column — 40% larger than the original 2800 layout. */
const STUDENT_WIDTH = 3920;
/** Coach lane — same width as the student column (was far too narrow at 1400). */
const AGENT_WIDTH = STUDENT_WIDTH;

/** Problem statements need real room to breathe at a readable font size. */
const CONSTRAINTS_H = 1960;
/** Monaco solution editor sits in this slot under the problem statement. */
const CODE_H = 784;
const APPROACH_H = 2380;
const COMPLEXITY_H = 896;
const WALKTHROUGH_H = 1960;

/**
 * Floors when the student shrinks a dashed frame. Shared student width uses
 * `minW` from any student region (they stay one column).
 * Agent minW matches the default so older saved boards expand on sync.
 */
export const REGION_MIN: Record<RegionId, { minW: number; minH: number }> = {
  constraints: { minW: 1680, minH: 1260 },
  code: { minW: 1680, minH: 448 },
  approach: { minW: 1680, minH: 980 },
  complexity: { minW: 1680, minH: 448 },
  walkthrough: { minW: 1680, minH: 784 },
  agent: { minW: AGENT_WIDTH, minH: 1260 },
};

const CODE_Y = CONSTRAINTS_H + GUTTER;
const APPROACH_Y = CODE_Y + CODE_H + GUTTER;
const COMPLEXITY_Y = APPROACH_Y + APPROACH_H + GUTTER;
const WALKTHROUGH_Y = COMPLEXITY_Y + COMPLEXITY_H + GUTTER;
const TOTAL_H = WALKTHROUGH_Y + WALKTHROUGH_H;

/** Student columns, top to bottom — used when reflowing resizable frames. */
export const STUDENT_REGION_ORDER: RegionId[] = [
  "constraints",
  "code",
  "approach",
  "complexity",
  "walkthrough",
];

export const REGIONS: Record<RegionId, Region> = {
  constraints: {
    id: "constraints",
    label: "Problem & constraints",
    x: 0,
    y: 0,
    w: STUDENT_WIDTH,
    h: CONSTRAINTS_H,
  },
  code: {
    id: "code",
    label: "Code",
    x: 0,
    y: CODE_Y,
    w: STUDENT_WIDTH,
    h: CODE_H,
  },
  approach: {
    id: "approach",
    label: "Approach",
    x: 0,
    y: APPROACH_Y,
    w: STUDENT_WIDTH,
    h: APPROACH_H,
  },
  complexity: {
    id: "complexity",
    label: "Complexity",
    x: 0,
    y: COMPLEXITY_Y,
    w: STUDENT_WIDTH,
    h: COMPLEXITY_H,
  },
  walkthrough: {
    id: "walkthrough",
    label: "Walkthrough",
    x: 0,
    y: WALKTHROUGH_Y,
    w: STUDENT_WIDTH,
    h: WALKTHROUGH_H,
  },
  agent: {
    id: "agent",
    label: "Coach",
    x: STUDENT_WIDTH + GUTTER * 2,
    y: 0,
    w: AGENT_WIDTH,
    h: TOTAL_H,
  },
};

export const AGENT_LANE = REGIONS.agent;

/** Inner padding, so diagrams don't touch the lane's border. */
export const AGENT_PADDING = 40;

/**
 * Vertical space each injected diagram gets. One constant, because the applier
 * and the slot calculator have to agree — when they drifted apart, a diagram
 * moved every time it was re-rendered.
 */
export const AGENT_SLOT_HEIGHT = 320;

/** Where the nth diagram in the agent lane starts. */
export function agentSlotOrigin(
  index: number,
  slotHeight = AGENT_SLOT_HEIGHT,
): { x: number; y: number } {
  return {
    x: AGENT_LANE.x + AGENT_PADDING,
    y: AGENT_LANE.y + AGENT_PADDING + index * slotHeight,
  };
}

/** Which region a point falls in, for tagging what the student wrote where. */
export function regionAt(x: number, y: number): RegionId | null {
  for (const region of Object.values(REGIONS)) {
    if (x >= region.x && x <= region.x + region.w && y >= region.y && y <= region.y + region.h) {
      return region.id;
    }
  }
  return null;
}

/** True when a diagram of this size still fits inside the lane. */
export function fitsInAgentLane(origin: { x: number; y: number }, width: number, height: number): boolean {
  return (
    origin.x >= AGENT_LANE.x &&
    origin.y >= AGENT_LANE.y &&
    origin.x + width <= AGENT_LANE.x + AGENT_LANE.w &&
    origin.y + height <= AGENT_LANE.y + AGENT_LANE.h
  );
}
