/**
 * A built-in stamp palette for code and system-design sketching.
 *
 * Each stamp opens a short modifier sheet (size, rows, label, …) before it is
 * placed. Stamp ink stays a fixed sketch colour — it does not follow Appearance.
 */

import { FONT_CODE, FONT_UI, TEXT_PRIMARY, type Skeleton } from "./skeleton";

export type ShapeModValue = string | number;

export interface ShapeModField {
  key: string;
  label: string;
  kind: "int" | "text";
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

/** Fixed sketch colours for stamps — independent of Appearance. */
export interface ShapePalette {
  ink: string;
  fill: string;
}

export const DEFAULT_SHAPE_PALETTE: ShapePalette = {
  ink: TEXT_PRIMARY,
  fill: "#f8fafc",
};

export interface ShapeStamp {
  id: string;
  label: string;
  /** Group heading in the picker. */
  group: "data structures" | "system design" | "flow";
  /** Built at a point with the modifier values from the configure sheet. */
  build: (
    x: number,
    y: number,
    mods: Record<string, ShapeModValue>,
    palette: ShapePalette,
  ) => Skeleton[];
  /** Fields shown after picking this stamp. */
  fields: ShapeModField[];
  defaults: Record<string, ShapeModValue>;
}

function box(
  palette: ShapePalette,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  options: { mono?: boolean; background?: string; roundness?: null | { type: number } } = {},
): Skeleton {
  return {
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    strokeColor: palette.ink,
    backgroundColor: options.background ?? palette.fill,
    fillStyle: "solid",
    strokeWidth: 1,
    roughness: 1,
    label: { text, fontSize: 16, strokeColor: palette.ink },
    fontFamily: options.mono ? FONT_CODE : FONT_UI,
  };
}

function arrow(palette: ShapePalette, x1: number, y1: number, x2: number, y2: number): Skeleton {
  return {
    type: "arrow",
    x: x1,
    y: y1,
    points: [
      [0, 0],
      [x2 - x1, y2 - y1],
    ],
    strokeColor: palette.ink,
    strokeWidth: 1,
    roughness: 1,
  };
}

function caption(palette: ShapePalette, x: number, y: number, text: string, mono = false): Skeleton {
  return {
    type: "text",
    x,
    y,
    text,
    fontSize: 14,
    fontFamily: mono ? FONT_CODE : FONT_UI,
    strokeColor: palette.ink,
  };
}

function intOf(mods: Record<string, ShapeModValue>, key: string, fallback: number): number {
  const raw = mods[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function textOf(mods: Record<string, ShapeModValue>, key: string, fallback: string): string {
  const raw = mods[key];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const SHAPES: ShapeStamp[] = [
  {
    id: "array",
    label: "Array",
    group: "data structures",
    fields: [{ key: "length", label: "Length", kind: "int", min: 1, max: 32, step: 1 }],
    defaults: { length: 5 },
    build: (x, y, mods, palette) => {
      const length = clampInt(intOf(mods, "length", 5), 1, 32);
      const cell = 56;
      const out: Skeleton[] = [];
      for (let i = 0; i < length; i++) {
        out.push(box(palette, x + i * cell, y, cell, cell, "", { mono: true }));
        out.push(caption(palette, x + i * cell + 6, y + cell + 6, String(i), true));
      }
      return out;
    },
  },
  {
    id: "grid",
    label: "Grid",
    group: "data structures",
    fields: [
      { key: "rows", label: "Rows", kind: "int", min: 1, max: 24, step: 1 },
      { key: "cols", label: "Cols", kind: "int", min: 1, max: 24, step: 1 },
    ],
    defaults: { rows: 3, cols: 4 },
    build: (x, y, mods, palette) => {
      const rows = clampInt(intOf(mods, "rows", 3), 1, 24);
      const cols = clampInt(intOf(mods, "cols", 4), 1, 24);
      const cell = 48;
      const out: Skeleton[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          out.push(box(palette, x + c * cell, y + r * cell, cell, cell, "", { mono: true }));
        }
      }
      return out;
    },
  },
  {
    id: "linked-list",
    label: "Linked list",
    group: "data structures",
    fields: [{ key: "nodes", label: "Nodes", kind: "int", min: 1, max: 24, step: 1 }],
    defaults: { nodes: 3 },
    build: (x, y, mods, palette) => {
      const nodes = clampInt(intOf(mods, "nodes", 3), 1, 24);
      const node = 72;
      const gap = 44;
      const out: Skeleton[] = [];
      for (let i = 0; i < nodes; i++) {
        const nx = x + i * (node + gap);
        out.push(box(palette, nx, y, node, 52, "", { mono: true }));
        if (i < nodes - 1) {
          out.push(arrow(palette, nx + node, y + 26, nx + node + gap - 6, y + 26));
        }
      }
      out.push(caption(palette, x + nodes * (node + gap) - gap, y + 18, "∅"));
      return out;
    },
  },
  {
    id: "tree",
    label: "Tree",
    group: "data structures",
    fields: [{ key: "levels", label: "Levels", kind: "int", min: 1, max: 10, step: 1 }],
    defaults: { levels: 2 },
    build: (x, y, mods, palette) => {
      const levels = clampInt(intOf(mods, "levels", 2), 1, 10);
      const size = 56;
      const vGap = 96;
      const leafCount = 2 ** Math.max(0, levels - 1);
      const hGap = size + 20;
      const totalWidth = Math.max(hGap, leafCount * hGap);
      const centers: Array<{ cx: number; cy: number; level: number; index: number }> = [];

      for (let level = 0; level < levels; level++) {
        const count = 2 ** level;
        const span = totalWidth / count;
        for (let i = 0; i < count; i++) {
          centers.push({
            level,
            index: i,
            cx: x + span * (i + 0.5),
            cy: y + level * vGap,
          });
        }
      }

      const out: Skeleton[] = [];
      for (const node of centers) {
        if (node.level === 0) continue;
        const parent = centers.find(
          (candidate) =>
            candidate.level === node.level - 1 && candidate.index === Math.floor(node.index / 2),
        );
        if (!parent) continue;
        out.push(arrow(palette, parent.cx, parent.cy + size, node.cx, node.cy));
      }
      for (const node of centers) {
        out.push(box(palette, node.cx - size / 2, node.cy, size, size, "", { mono: true }));
      }
      return out;
    },
  },
  {
    id: "stack",
    label: "Stack",
    group: "data structures",
    fields: [{ key: "height", label: "Height", kind: "int", min: 1, max: 20, step: 1 }],
    defaults: { height: 4 },
    build: (x, y, mods, palette) => {
      const height = clampInt(intOf(mods, "height", 4), 1, 20);
      const out: Skeleton[] = [];
      for (let i = 0; i < height; i++) {
        out.push(box(palette, x, y + i * 44, 120, 44, "", { mono: true }));
      }
      out.push(caption(palette, x + 132, y + 12, "← top"));
      return out;
    },
  },
  {
    id: "hashmap",
    label: "Hash map",
    group: "data structures",
    fields: [{ key: "rows", label: "Rows", kind: "int", min: 1, max: 20, step: 1 }],
    defaults: { rows: 4 },
    build: (x, y, mods, palette) => {
      const rows = clampInt(intOf(mods, "rows", 4), 1, 20);
      const out: Skeleton[] = [
        caption(palette, x, y - 22, "key"),
        caption(palette, x + 132, y - 22, "value"),
      ];
      for (let i = 0; i < rows; i++) {
        out.push(box(palette, x, y + i * 42, 124, 42, "", { mono: true }));
        out.push(box(palette, x + 128, y + i * 42, 124, 42, "", { mono: true }));
      }
      return out;
    },
  },
  {
    id: "service",
    label: "Server",
    group: "system design",
    fields: [{ key: "label", label: "Label", kind: "text", placeholder: "Server" }],
    defaults: { label: "Server" },
    build: (x, y, mods, palette) => [box(palette, x, y, 200, 88, textOf(mods, "label", "Server"))],
  },
  {
    id: "database",
    label: "Database",
    group: "system design",
    fields: [{ key: "label", label: "Label", kind: "text", placeholder: "DB" }],
    defaults: { label: "DB" },
    build: (x, y, mods, palette) => [
      { ...box(palette, x, y, 160, 100, textOf(mods, "label", "DB")), type: "ellipse" },
      box(palette, x, y + 24, 160, 76, "", { background: "transparent" }),
    ],
  },
  {
    id: "queue",
    label: "Queue / topic",
    group: "system design",
    fields: [{ key: "slots", label: "Slots", kind: "int", min: 1, max: 24, step: 1 }],
    defaults: { slots: 4 },
    build: (x, y, mods, palette) => {
      const slots = clampInt(intOf(mods, "slots", 4), 1, 24);
      const out: Skeleton[] = [caption(palette, x, y - 22, "front")];
      for (let i = 0; i < slots; i++) {
        out.push(box(palette, x + i * 60, y, 60, 52, "", { mono: true }));
      }
      out.push(caption(palette, x + slots * 60 - 44, y + 58, "back"));
      return out;
    },
  },
  {
    id: "client",
    label: "Client",
    group: "system design",
    fields: [{ key: "label", label: "Label", kind: "text", placeholder: "Client" }],
    defaults: { label: "Client" },
    build: (x, y, mods, palette) => [
      box(palette, x, y, 140, 90, textOf(mods, "label", "Client")),
      arrow(palette, x + 140, y + 45, x + 240, y + 45),
    ],
  },
  {
    id: "decision",
    label: "Decision",
    group: "flow",
    fields: [
      { key: "prompt", label: "Prompt", kind: "text", placeholder: "?" },
      { key: "yes", label: "Yes label", kind: "text", placeholder: "yes" },
      { key: "no", label: "No label", kind: "text", placeholder: "no" },
    ],
    defaults: { prompt: "?", yes: "yes", no: "no" },
    build: (x, y, mods, palette) => [
      { ...box(palette, x, y, 160, 96, textOf(mods, "prompt", "?")), type: "diamond" },
      arrow(palette, x + 160, y + 48, x + 250, y + 48),
      arrow(palette, x + 80, y + 96, x + 80, y + 180),
      caption(palette, x + 258, y + 34, textOf(mods, "yes", "yes")),
      caption(palette, x + 90, y + 130, textOf(mods, "no", "no")),
    ],
  },
  {
    id: "loop",
    label: "Loop",
    group: "flow",
    fields: [{ key: "label", label: "Label", kind: "text", placeholder: "for i in …" }],
    defaults: { label: "for i in …" },
    build: (x, y, mods, palette) => [
      box(palette, x, y, 190, 76, textOf(mods, "label", "for i in …"), { mono: true }),
      arrow(palette, x + 190, y + 38, x + 270, y + 38),
      arrow(palette, x + 270, y + 38, x + 270, y + 130),
      arrow(palette, x + 270, y + 130, x + 95, y + 130),
      arrow(palette, x + 95, y + 130, x + 95, y + 78),
    ],
  },
];

export const SHAPE_GROUPS = ["data structures", "system design", "flow"] as const;

export function shapesInGroup(group: ShapeStamp["group"]): ShapeStamp[] {
  return SHAPES.filter((shape) => shape.group === group);
}

/** Fill missing keys from stamp defaults (used when placing). */
export function resolveShapeMods(
  shape: ShapeStamp,
  mods: Record<string, ShapeModValue>,
): Record<string, ShapeModValue> {
  return { ...shape.defaults, ...mods };
}
