/**
 * The element-skeleton shape `convertToExcalidrawElements` accepts.
 *
 * Declared locally rather than imported from Excalidraw's internals: it keeps
 * the templates and the viz renderers pure — testable in Node, with no DOM and
 * no Excalidraw bundle — and it pins exactly which properties this app relies
 * on across Excalidraw versions.
 */

export interface Skeleton {
  /**
   * Explicit ids matter for viz groups: stepping frames must *replace* elements
   * rather than pile new ones up, and that only works if the same logical cell
   * keeps the same id from frame to frame.
   */
  id?: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch";
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  roughness?: number;
  opacity?: number;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  points?: Array<[number, number]>;
  locked?: boolean;
  customData?: SkeletonMeta | null;
  label?: { text: string; fontSize?: number; strokeColor?: string };
}

export interface SkeletonMeta {
  /** Set on template scaffolding, so the coach knows which region is which. */
  lcRegion?: string;
  /**
   * Set on every element the coach injected. Two jobs: the capture layer skips
   * these so the coach never reads its own output back, and the viz applier
   * replaces exactly this group when the frame changes.
   */
  lcVizId?: string;
  /** Stable slot name within a viz group, e.g. `cell:3`, `ptr:i`. */
  lcSlot?: string;
}

/** Muted palette: the coach's ink should read as annotation, not as the work. */
export const COACH_INK = "#5b6478";
export const COACH_ACCENT = "#c2410c";
export const COACH_FILL = "#f1f5f9";
export const STUDENT_HINT = "#9aa3af";
export const TEXT_PRIMARY = "#1e1e1e";
export const TEXT_BODY = "#2f3542";

/**
 * Excalidraw font ids.
 *
 * Deliberately **not** the hand-drawn default (Excalifont/Virgil). A problem
 * statement is reference material you read for twenty minutes while sketching;
 * it has to be as legible as the problems page, not stylised. Prose gets a
 * normal sans, and anything with brackets, subscripts, or array literals gets
 * the monospace face so `mat[i][j]` and `[[0,0,0],[0,1,0]]` stay readable.
 */
export const FONT_UI = 2; // Helvetica — prose
export const FONT_CODE = 3; // Cascadia — code, examples, constraints

/** Default size for the text tool, overridable from the toolbar. */
export const FONT_SIZES = [16, 20, 28, 36] as const;
export const DEFAULT_FONT_SIZE = 20;

/** Board background options. Light-first; a stylus session is usually daytime. */
export interface BoardTheme {
  id: string;
  label: string;
  background: string;
  /** Grid/edge colour that stays visible on this background. */
  hint: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  { id: "paper", label: "Paper", background: "#ffffff", hint: "#9aa3af" },
  { id: "warm", label: "Warm", background: "#fdf8f0", hint: "#a8a29e" },
  { id: "cool", label: "Cool", background: "#f4f8fb", hint: "#94a3b8" },
  { id: "sage", label: "Sage", background: "#f3f7f3", hint: "#94a89a" },
  { id: "slate", label: "Slate", background: "#e9ecef", hint: "#8b95a1" },
];

/** Tag a whole group as the coach's, so capture and replacement both work. */
export function tagViz(skeletons: Skeleton[], vizId: string): Skeleton[] {
  return skeletons.map((skeleton) => ({
    ...skeleton,
    // Injected diagrams are locked: a stray palm shouldn't drag the coach's
    // annotation across the student's work.
    locked: skeleton.locked ?? true,
    customData: { ...skeleton.customData, lcVizId: vizId },
  }));
}

/** Deterministic id for one slot of one viz group. */
export function vizElementId(vizId: string, slot: string): string {
  return `lcviz-${vizId}-${slot}`;
}
