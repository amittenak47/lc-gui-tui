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
  lineHeight?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch";
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  roughness?: number;
  opacity?: number;
  /** Excalidraw roundness; `{ type: 3 }` is adaptive corner radius. */
  roundness?: null | { type: number };
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  /** When false, width/height + textAlign/verticalAlign center text in the box. */
  autoResize?: boolean;
  points?: Array<[number, number]>;
  locked?: boolean;
  /** Radians — template frames stay at 0. */
  angle?: number;
  customData?: SkeletonMeta | null;
  label?: {
    text: string;
    fontSize?: number;
    strokeColor?: string;
    textAlign?: "left" | "center" | "right";
    verticalAlign?: "top" | "middle" | "bottom";
  };
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
  /** Authored offset before reading-size reflow; chrome restores to this. */
  lcRegionOyBase?: number;
  /** Authored scene font; reading-size scales body from this, chrome restores to it. */
  lcFontBase?: number;
  /** lineHeight / fontSize at authoring time. */
  lcLineHeightBase?: number;
  lcHeightBase?: number;
  lcWidthBase?: number;
  /**
   * Keep width/height as authored (chips, badges). Statement body text still
   * stretches to the frame content width.
   */
  lcFixedSize?: boolean;
  /**
   * Set on every element the coach injected. Two jobs: the capture layer skips
   * these so the coach never reads its own output back, and the viz applier
   * replaces exactly this group when the frame changes.
   */
  lcVizId?: string;
  /** Stable slot name within a viz group, e.g. `cell:3`, `ptr:i`. */
  lcSlot?: string;
  /** Scratchpad notebook page index (0-based). */
  lcScratchPage?: number;
  /** Dashed frame for a scratchpad notebook page. */
  lcScratchFrame?: boolean;
}

/** Muted palette: the coach's ink should read as annotation, not as the work. */
export const COACH_INK = "#5b6478";
export const COACH_ACCENT = "#c2410c";
export const COACH_FILL = "#f1f5f9";
export const STUDENT_HINT = "#4b5563";
/** Near-black dashed frames — stay readable on light boards when zoomed out. */
export const REGION_BORDER = "#0c0a08";
export const TEXT_PRIMARY = "#14110e";
export const TEXT_BODY = "#1f1a14";

/** Template ink — pick for board brightness so statement text stays readable. */
export function templatePalette(dark: boolean) {
  return dark
    ? {
        primary: "#f3f4f6",
        body: "#e5e7eb",
        hint: "#9ca3af",
        // Lighter than board so dashed frames stay visible on midnight/graphite.
        border: "#d1d5db",
      }
    : {
        primary: TEXT_PRIMARY,
        body: TEXT_BODY,
        hint: STUDENT_HINT,
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
export const FONT_SIZES = [16, 20, 28] as const;
export const FONT_SIZE_LABELS: Record<(typeof FONT_SIZES)[number], string> = {
  16: "S",
  20: "M",
  28: "L",
};
/** Default typed-note size (canvas px). Wheel range is 16–144. */
export const DEFAULT_FONT_SIZE = 48;

/** Board background options. Light-first; a stylus session is usually daytime. */
export interface BoardTheme {
  id: string;
  label: string;
  background: string;
  /** Grid/edge colour that stays visible on this background. */
  hint: string;
}

/**
 * Appearance swatches — six light tints, then six dark counterparts.
 * Hues: sky → mint → rose → peach → lilac → coral | ocean → forest → wine → umber → plum → storm.
 */
export const BOARD_THEMES: BoardTheme[] = [
  { id: "blue", label: "Sky", background: "#d6e8ff", hint: "#5b7fa8" },
  { id: "green", label: "Mint", background: "#d4f0e4", hint: "#4d8f72" },
  { id: "pink", label: "Rose", background: "#fce1ea", hint: "#a8657f" },
  { id: "beige", label: "Peach", background: "#f9e8d4", hint: "#9a7f5e" },
  { id: "purple", label: "Lilac", background: "#ebe2f8", hint: "#7d6a9e" },
  { id: "coral", label: "Coral", background: "#ffe8df", hint: "#b07a68" },
  { id: "ocean", label: "Ocean", background: "#0f1a24", hint: "#6a9cc4" },
  { id: "pine", label: "Forest", background: "#101f18", hint: "#6baf8f" },
  { id: "dusk", label: "Wine", background: "#281820", hint: "#c48a9a" },
  { id: "graphite", label: "Umber", background: "#1c1916", hint: "#a89882" },
  { id: "midnight", label: "Plum", background: "#16122a", hint: "#9a88c4" },
  { id: "storm", label: "Storm", background: "#141c28", hint: "#7a98b8" },
];

/** Tag a whole group as the coach's, so capture and replacement both work. */
export function tagViz(skeletons: Skeleton[], vizId: string): Skeleton[] {
  return skeletons.map((skeleton) => ({
    ...skeleton,
    // Injected diagrams are locked: a stray palm shouldn't drag the coach's
    // annotation across the student's work.
    locked: skeleton.locked ?? true,
    customData: {
      ...skeleton.customData,
      lcVizId: vizId,
      // Mobile paging keys off lcRegion; without this, a centre that falls near
      // a student frame can park the diagram on a page the student never opens.
      lcRegion: skeleton.customData?.lcRegion ?? "agent",
    },
  }));
}

/** Deterministic id for one slot of one viz group. */
export function vizElementId(vizId: string, slot: string): string {
  return `lcviz-${vizId}-${slot}`;
}
