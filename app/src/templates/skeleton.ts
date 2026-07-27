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
  /** Dashed region border — unlocked so the student can resize the layout. */
  lcRegionFrame?: boolean;
  /**
   * Position relative to the region frame's top-left. Used when syncing layout
   * so resizing a frame from the top/left doesn't leave statement text stranded.
   */
  lcRegionOx?: number;
  lcRegionOy?: number;
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
export const STUDENT_HINT = "#4b5563";
export const REGION_BORDER = "#1a1612";
export const TEXT_PRIMARY = "#14110e";
export const TEXT_BODY = "#1f1a14";

/** Template ink — pick for board brightness so statement text stays readable. */
export function templatePalette(dark: boolean) {
  return dark
    ? {
        primary: "#f3f4f6",
        body: "#e5e7eb",
        hint: "#9ca3af",
        border: "#9ca3af",
      }
    : {
        primary: TEXT_PRIMARY,
        body: TEXT_BODY,
        hint: STUDENT_HINT,
        // Dark dashed frames on light boards so regions stay readable on parchment.
        border: REGION_BORDER,
      };
}

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
  { id: "parchment", label: "Parchment", background: "#f5f0e4", hint: "#8a7f6c" },
  { id: "linen", label: "Linen", background: "#ebe3d4", hint: "#857a68" },
  { id: "sand", label: "Sand", background: "#e8dcc4", hint: "#8a7d66" },
  { id: "papyrus", label: "Papyrus", background: "#ddd0b4", hint: "#7a6f58" },
  { id: "wheat", label: "Wheat", background: "#e5d4b0", hint: "#8a7758" },
  { id: "midnight", label: "Midnight", background: "#1a1d23", hint: "#6b7280" },
  { id: "graphite", label: "Graphite", background: "#23262e", hint: "#7a8494" },
  { id: "ocean", label: "Ocean", background: "#1a2229", hint: "#6b8099" },
  { id: "pine", label: "Pine", background: "#1a211e", hint: "#6b8a7a" },
  { id: "dusk", label: "Dusk", background: "#221e24", hint: "#8a7a85" },
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
