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

import { READING_COLUMN_MAX, READING_COLUMN_MIN } from "./readingColumn";

export type RegionId =
  | "constraints"
  | "code"
  | "approach"
  | "complexity"
  | "walkthrough"
  | "scratch"
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

/**
 * Desk showing between two stacked pages.
 *
 * The board scrolls as one continuous document, so the only thing telling a
 * reader that Code ended and Approach began is the gap between the sheets. At
 * one `REGION_GUTTER` there was effectively none: 64 units under a 2352-unit
 * page is a hairline at fit zoom, and the pages read as a single roll of paper.
 *
 * It also has to survive growth. A draw page keeps half a page of blank buffer
 * below the ink so there is always somewhere to keep writing, and `growDrawHeight`
 * adds another half-page whenever the ink reaches it. `syncRegionLayout` re-stacks
 * everything below, so that buffer never *overlaps* its neighbour — but flush
 * against the next sheet it is indistinguishable from it, and the page appears to
 * bleed into the next one. A break wide enough to see is what makes growth read
 * as "this page got longer" instead.
 *
 * Vertical only. Side by side, the coach lane still sits one `REGION_GUTTER`
 * away — that gap is between columns, not between pages.
 */
export const PAGE_BREAK = 288;
/** Student column — 40% larger than the original 2800 layout. */
const STUDENT_WIDTH = 3920;
/** Coach lane — same width as the student column (was far too narrow at 1400). */
const AGENT_WIDTH = STUDENT_WIDTH;

/**
 * Starting height for the statement page.
 *
 * Only a starting point: the fit grows it to a screenful and the layout sync
 * grows it to the text. It came down from 1960 when the page became a reading
 * column — that number was a fifth of a four-screen-wide desk, and on a phone
 * column it is five screens of blank paper under a short problem.
 */
const CONSTRAINTS_H = 900;
/** Monaco solution editor sits in this slot under the problem statement. */
const CODE_H = 2352; // 3× the original 784 — room for Imports + Solution without feeling cramped
const APPROACH_H = 2380;
const COMPLEXITY_H = 896;
const WALKTHROUGH_H = 1960;

/**
 * Floors when the student shrinks a dashed frame. Shared student width uses
 * `minW` from any student region (they stay one column).
 * Agent minW matches the default so older saved boards expand on sync.
 */
export const REGION_MIN: Record<RegionId, { minW: number; minH: number }> = {
  // The statement is a reading column, not a student frame: it is as wide as
  // the viewport's measure and as tall as the text. Its floors are a document's
  // floors — anything larger would pad a short problem with empty page.
  constraints: { minW: READING_COLUMN_MIN, minH: 600 },
  code: { minW: 1680, minH: 1344 },
  approach: { minW: 1680, minH: 980 },
  complexity: { minW: 1680, minH: 448 },
  walkthrough: { minW: 1680, minH: 784 },
  scratch: { minW: 1680, minH: 784 },
  agent: { minW: AGENT_WIDTH, minH: 1260 },
};

const CODE_Y = CONSTRAINTS_H + PAGE_BREAK;
const APPROACH_Y = CODE_Y + CODE_H + PAGE_BREAK;
const COMPLEXITY_Y = APPROACH_Y + APPROACH_H + PAGE_BREAK;
const WALKTHROUGH_Y = COMPLEXITY_Y + COMPLEXITY_H + PAGE_BREAK;
const SCRATCH_Y = WALKTHROUGH_Y + WALKTHROUGH_H + PAGE_BREAK;
const SCRATCH_H = 1960;
const TOTAL_H = SCRATCH_Y + SCRATCH_H;

/** Student columns, top to bottom — used when reflowing resizable frames. */
export const STUDENT_REGION_ORDER: RegionId[] = [
  "constraints",
  "code",
  "approach",
  "complexity",
  "walkthrough",
  "scratch",
];

/**
 * Mobile page turner order. Coach diagrams live in the agent lane (not
 * Walkthrough); without this page they render but stay opacity-0 forever.
 */
export const MOBILE_REGION_ORDER: RegionId[] = [...STUDENT_REGION_ORDER, "agent"];

export const REGIONS: Record<RegionId, Region> = {
  constraints: {
    id: "constraints",
    label: "Problem & constraints",
    x: 0,
    y: 0,
    // A measure, not a desk — the live frame is sized to the viewport, and this
    // is the ceiling it is capped at. See `readingColumn`.
    w: READING_COLUMN_MAX,
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
  scratch: {
    id: "scratch",
    label: "Scratch",
    x: 0,
    y: SCRATCH_Y,
    w: STUDENT_WIDTH,
    h: SCRATCH_H,
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
 * Extra top inset so slot 0 clears the agent title + "Coach diagrams land here"
 * hint. Every slot (including wrap-to-0) shares this origin — without it, Draw
 * ink overlaps the template chrome.
 */
export const AGENT_CONTENT_TOP = 110;

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
  /** Live agent-frame X after layout sync; falls back to the template lane. */
  laneX = AGENT_LANE.x,
): { x: number; y: number } {
  return {
    x: laneX + AGENT_PADDING,
    y: AGENT_LANE.y + AGENT_CONTENT_TOP + index * slotHeight,
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
