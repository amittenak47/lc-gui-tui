/**
 * Blank multipage notebook — not the problem-region board.
 *
 * Each page is a dashed frame tagged `lcRegion: pad-{n}` so the existing
 * mobile page-visibility / fit path can treat it like a region without
 * inventing fake entries in REGIONS.
 */

import { FONT_UI, templatePalette, type Skeleton } from "./skeleton";
import { SCRATCHPAD_PAGE_LIMIT } from "../util/scratchpadStore";

export const SCRATCHPAD_TASK_ID = "__scratchpad__";
export const SCRATCHPAD_DATASET = "scratchpad";

export { SCRATCHPAD_PAGE_LIMIT };

/** Scene size of one notebook page (student-column scale). */
export const SCRATCH_PAGE_W = 3920;
/**
 * Taller than a problem region so a scratch page fills more of the canvas when
 * Coach is closed; fitView still shrinks it to the viewport when Coach opens.
 */
export const SCRATCH_PAGE_H = 4200;
export const SCRATCH_PAGE_GUTTER = 64;

export function scratchPageId(index: number): string {
  return `pad-${index}`;
}

export function parseScratchPageId(id: string | null | undefined): number | null {
  if (!id) return null;
  const match = /^pad-(\d+)$/.exec(id);
  if (!match) return null;
  return Number(match[1]);
}

export function scratchPageOrigin(index: number): { x: number; y: number } {
  return {
    x: 0,
    y: index * (SCRATCH_PAGE_H + SCRATCH_PAGE_GUTTER),
  };
}

/** One blank page frame + title chrome. */
export function buildScratchPageSkeletons(
  index: number,
  dark = false,
): Skeleton[] {
  const ink = templatePalette(dark);
  const { x, y } = scratchPageOrigin(index);
  const region = scratchPageId(index);
  const textWidth = SCRATCH_PAGE_W - 72;

  const at = (ox: number, oy: number, extra: Record<string, unknown> = {}) => ({
    lcRegion: region,
    lcRegionOx: ox - x,
    lcRegionOy: oy - y,
    lcScratchPage: index,
    ...extra,
  });

  const skeletons: Skeleton[] = [
    {
      id: `lcscratch-${index}-frame`,
      type: "rectangle",
      x,
      y,
      width: SCRATCH_PAGE_W,
      height: SCRATCH_PAGE_H,
      strokeColor: ink.border,
      backgroundColor: "transparent",
      strokeStyle: "dashed",
      strokeWidth: 2,
      roughness: 0,
      opacity: 100,
      locked: false,
      angle: 0,
      customData: {
        lcRegion: region,
        lcRegionFrame: true,
        lcScratchPage: index,
        lcScratchFrame: true,
      },
    },
    {
      id: `lcscratch-${index}-label`,
      type: "text",
      x: x + 36,
      y: y + 24,
      width: textWidth,
      text: `PAGE ${index + 1}`,
      fontSize: 20,
      fontFamily: FONT_UI,
      strokeColor: ink.hint,
      opacity: 100,
      locked: true,
      customData: {
        ...at(x + 36, y + 24),
        lcFontBase: 20,
        lcFixedSize: true,
      },
    },
  ];

  if (index === 0) {
    skeletons.push({
      id: `lcscratch-${index}-title`,
      type: "text",
      x: x + 36,
      y: y + 64,
      width: textWidth,
      text: "Scratchpad",
      fontSize: 56,
      fontFamily: FONT_UI,
      strokeColor: ink.primary,
      locked: true,
      customData: {
        ...at(x + 36, y + 64),
        lcFontBase: 56,
        lcFixedSize: true,
      },
    });
    skeletons.push({
      id: `lcscratch-${index}-hint`,
      type: "text",
      x: x + 36,
      y: y + 160,
      width: textWidth,
      text: "Blank notebook — Next adds a page. Saves live on this device.",
      fontSize: 26,
      fontFamily: FONT_UI,
      strokeColor: ink.hint,
      locked: true,
      customData: {
        ...at(x + 36, y + 160),
        lcFontBase: 26,
      },
    });
  }

  return skeletons;
}

/** Fresh notebook with `pageCount` blank pages (at least one). */
export function buildScratchpadTemplate(pageCount = 1, dark = false): Skeleton[] {
  const count = Math.min(
    SCRATCHPAD_PAGE_LIMIT,
    Math.max(1, Math.floor(pageCount)),
  );
  const skeletons: Skeleton[] = [];
  for (let i = 0; i < count; i += 1) {
    skeletons.push(...buildScratchPageSkeletons(i, dark));
  }
  return skeletons;
}

/** Highest page index present in a saved element list (0 if none). */
export function countScratchPages(elements: readonly unknown[]): number {
  let max = -1;
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const meta = (raw as { customData?: { lcScratchPage?: unknown } }).customData;
    const page = meta?.lcScratchPage;
    if (typeof page === "number" && Number.isFinite(page)) {
      max = Math.max(max, Math.floor(page));
    }
  }
  return Math.max(0, max) + 1;
}

type ScratchMeta = {
  lcScratchPage?: unknown;
  lcScratchFrame?: boolean;
  lcRegionOx?: number;
  lcRegionOy?: number;
};

/**
 * Resize / restack scratch page frames to the current template size so older
 * notebooks pick up taller pages without stranding ink.
 */
export function healScratchpadGeometry(elements: readonly unknown[]): unknown[] {
  const frames: { page: number; y: number }[] = [];
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as { y?: unknown; customData?: ScratchMeta | null };
    const meta = el.customData;
    if (!meta?.lcScratchFrame) continue;
    const page = meta.lcScratchPage;
    if (typeof page !== "number" || !Number.isFinite(page)) continue;
    frames.push({ page: Math.floor(page), y: typeof el.y === "number" ? el.y : 0 });
  }
  if (frames.length === 0) return [...elements];

  const dyByPage = new Map<number, number>();
  for (const frame of frames) {
    const nextY = scratchPageOrigin(frame.page).y;
    dyByPage.set(frame.page, nextY - frame.y);
  }

  return elements.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const el = raw as {
      y?: unknown;
      x?: unknown;
      width?: unknown;
      height?: unknown;
      customData?: ScratchMeta | null;
    };
    const meta = el.customData;
    const pageRaw = meta?.lcScratchPage;
    if (typeof pageRaw !== "number" || !Number.isFinite(pageRaw)) return raw;
    const page = Math.floor(pageRaw);
    const dy = dyByPage.get(page) ?? 0;
    const origin = scratchPageOrigin(page);

    if (meta?.lcScratchFrame) {
      const keepH =
        typeof el.height === "number" && Number.isFinite(el.height) && el.height >= 400
          ? el.height
          : SCRATCH_PAGE_H;
      return {
        ...el,
        x: origin.x,
        y: origin.y,
        width: SCRATCH_PAGE_W,
        height: keepH,
      };
    }

    if (
      meta &&
      typeof meta.lcRegionOx === "number" &&
      typeof meta.lcRegionOy === "number"
    ) {
      return {
        ...el,
        x: origin.x + meta.lcRegionOx,
        y: origin.y + meta.lcRegionOy,
      };
    }

    if (dy === 0) return raw;
    return {
      ...el,
      y: (typeof el.y === "number" ? el.y : 0) + dy,
    };
  });
}
