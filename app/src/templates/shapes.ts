/**
 * A built-in stamp palette for code and system-design sketching.
 *
 * Excalidraw's own libraries are `.excalidrawlib` bundles fetched from
 * libraries.excalidraw.com, which a LAN-only tablet app cannot rely on. These
 * are defined as ordinary skeletons instead: no network, no CSP exemption, and
 * they land wherever the student taps rather than at a fixed offset.
 *
 * Deliberately small — the shapes that keep coming up when whiteboarding an
 * algorithm or a system, and nothing else.
 */

import { FONT_CODE, FONT_UI, TEXT_PRIMARY, type Skeleton } from "./skeleton";

export interface ShapeStamp {
  id: string;
  label: string;
  /** Group heading in the picker. */
  group: "data structures" | "system design" | "flow";
  /** Built at a point, so a stamp appears where it is dropped. */
  build: (x: number, y: number) => Skeleton[];
}

const INK = TEXT_PRIMARY;
const FILL = "#f8fafc";

function box(
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
    strokeColor: INK,
    backgroundColor: options.background ?? FILL,
    fillStyle: "solid",
    strokeWidth: 1,
    roughness: 1,
    label: { text, fontSize: 16 },
    fontFamily: options.mono ? FONT_CODE : FONT_UI,
  };
}

function arrow(x1: number, y1: number, x2: number, y2: number): Skeleton {
  return {
    type: "arrow",
    x: x1,
    y: y1,
    points: [
      [0, 0],
      [x2 - x1, y2 - y1],
    ],
    strokeColor: INK,
    strokeWidth: 1,
    roughness: 1,
  };
}

function caption(x: number, y: number, text: string, mono = false): Skeleton {
  return {
    type: "text",
    x,
    y,
    text,
    fontSize: 14,
    fontFamily: mono ? FONT_CODE : FONT_UI,
    strokeColor: INK,
  };
}

export const SHAPES: ShapeStamp[] = [
  {
    id: "array",
    label: "Array",
    group: "data structures",
    build: (x, y) => {
      const cell = 56;
      const out: Skeleton[] = [];
      for (let i = 0; i < 5; i++) {
        out.push(box(x + i * cell, y, cell, cell, "", { mono: true }));
        out.push(caption(x + i * cell + 6, y + cell + 6, String(i), true));
      }
      return out;
    },
  },
  {
    id: "grid",
    label: "Grid",
    group: "data structures",
    build: (x, y) => {
      const cell = 48;
      const out: Skeleton[] = [];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 4; c++) {
          out.push(box(x + c * cell, y + r * cell, cell, cell, "", { mono: true }));
        }
      }
      return out;
    },
  },
  {
    id: "linked-list",
    label: "Linked list",
    group: "data structures",
    build: (x, y) => {
      const node = 72;
      const gap = 44;
      const out: Skeleton[] = [];
      for (let i = 0; i < 3; i++) {
        const nx = x + i * (node + gap);
        out.push(box(nx, y, node, 52, "", { mono: true }));
        out.push(arrow(nx + node, y + 26, nx + node + gap - 6, y + 26));
      }
      out.push(caption(x + 3 * (node + gap), y + 18, "∅"));
      return out;
    },
  },
  {
    id: "tree",
    label: "Tree node",
    group: "data structures",
    build: (x, y) => [
      box(x + 96, y, 64, 64, "", { mono: true }),
      arrow(x + 112, y + 64, x + 40, y + 120),
      arrow(x + 144, y + 64, x + 216, y + 120),
      box(x, y + 120, 64, 64, "", { mono: true }),
      box(x + 192, y + 120, 64, 64, "", { mono: true }),
    ],
  },
  {
    id: "stack",
    label: "Stack",
    group: "data structures",
    build: (x, y) => {
      const out: Skeleton[] = [];
      for (let i = 0; i < 4; i++) {
        out.push(box(x, y + i * 44, 120, 44, "", { mono: true }));
      }
      out.push(caption(x + 132, y + 12, "← top"));
      return out;
    },
  },
  {
    id: "hashmap",
    label: "Hash map",
    group: "data structures",
    build: (x, y) => {
      const out: Skeleton[] = [caption(x, y - 22, "key"), caption(x + 132, y - 22, "value")];
      for (let i = 0; i < 4; i++) {
        out.push(box(x, y + i * 42, 124, 42, "", { mono: true }));
        out.push(box(x + 128, y + i * 42, 124, 42, "", { mono: true }));
      }
      return out;
    },
  },
  {
    id: "service",
    label: "Service",
    group: "system design",
    build: (x, y) => [box(x, y, 200, 88, "Service")],
  },
  {
    id: "database",
    label: "Database",
    group: "system design",
    build: (x, y) => [
      { ...box(x, y, 160, 100, "DB"), type: "ellipse" },
      box(x, y + 24, 160, 76, "", { background: "transparent" }),
    ],
  },
  {
    id: "queue",
    label: "Queue / topic",
    group: "system design",
    build: (x, y) => {
      const out: Skeleton[] = [caption(x, y - 22, "front")];
      for (let i = 0; i < 4; i++) {
        out.push(box(x + i * 60, y, 60, 52, "", { mono: true }));
      }
      out.push(caption(x + 4 * 60 - 44, y + 58, "back"));
      return out;
    },
  },
  {
    id: "client",
    label: "Client",
    group: "system design",
    build: (x, y) => [
      box(x, y, 140, 90, "Client"),
      arrow(x + 140, y + 45, x + 240, y + 45),
    ],
  },
  {
    id: "decision",
    label: "Decision",
    group: "flow",
    build: (x, y) => [
      { ...box(x, y, 160, 96, "?"), type: "diamond" },
      arrow(x + 160, y + 48, x + 250, y + 48),
      arrow(x + 80, y + 96, x + 80, y + 180),
      caption(x + 258, y + 34, "yes"),
      caption(x + 90, y + 130, "no"),
    ],
  },
  {
    id: "loop",
    label: "Loop",
    group: "flow",
    build: (x, y) => [
      box(x, y, 190, 76, "for i in …", { mono: true }),
      arrow(x + 190, y + 38, x + 270, y + 38),
      arrow(x + 270, y + 38, x + 270, y + 130),
      arrow(x + 270, y + 130, x + 95, y + 130),
      arrow(x + 95, y + 130, x + 95, y + 78),
    ],
  },
];

export const SHAPE_GROUPS = ["data structures", "system design", "flow"] as const;

export function shapesInGroup(group: ShapeStamp["group"]): ShapeStamp[] {
  return SHAPES.filter((shape) => shape.group === group);
}
