/**
 * The board's fixed geography.
 *
 * The student writes in the left-hand regions; the coach's injected diagrams
 * land only in the **agent lane** on the right, so they can never collide with
 * handwriting. Both the templates and the viz renderers read these numbers, so
 * there is one source of truth for where anything goes.
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
const STUDENT_WIDTH = 2800;
const AGENT_WIDTH = 1400;

/** Problem statements need real room to breathe at a readable font size. */
const CONSTRAINTS_H = 1400;
/** Monaco solution editor sits in this slot under the problem statement. */
const CODE_H = 560;
const APPROACH_H = 1700;
const COMPLEXITY_H = 640;
const WALKTHROUGH_H = 1400;

/**
 * Floors when the student shrinks a dashed frame. Shared student width uses
 * `minW` from any student region (they stay one column).
 */
export const REGION_MIN: Record<RegionId, { minW: number; minH: number }> = {
  constraints: { minW: 1200, minH: 900 },
  code: { minW: 1200, minH: 320 },
  approach: { minW: 1200, minH: 700 },
  complexity: { minW: 1200, minH: 320 },
  walkthrough: { minW: 1200, minH: 560 },
  agent: { minW: 640, minH: 900 },
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
    label: "Solution code",
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
