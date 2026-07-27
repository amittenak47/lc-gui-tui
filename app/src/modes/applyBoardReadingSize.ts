/**
 * Scale problem-statement body + title for the board reading size.
 *
 * Scales only:
 *   - `lcregion-constraints-title`
 *   - `lcregion-constraints-body-*`
 *
 * Leaves alone (fixed chrome / layout):
 *   - region labels ("PROBLEM & CONSTRAINTS", "CODE", "COACH", …)
 *   - region hints
 *   - difficulty / tag chips and their rule
 *   - frames
 *
 * Monaco size is handled separately via {@link codeFontPx}.
 */

import { READING_SCALE, type BoardReadingSize } from "./codeFontSize";

type ReadingMeta = {
  lcRegion?: string;
  lcRegionFrame?: boolean;
  lcVizId?: string;
  lcFontBase?: number;
  lcRegionOx?: number;
  lcRegionOy?: number;
  lcRegionOyBase?: number;
  lcHeightBase?: number;
  lcWidthBase?: number;
  lcFixedSize?: boolean;
};

export type ReadingElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  fontSize?: number;
  customData?: ReadingMeta | null;
};

/** Statement title + body only — not region chrome or tag chips. */
function isReadingContent(element: ReadingElement): boolean {
  if (element.customData?.lcVizId) return false;
  if (element.customData?.lcFixedSize) return false;
  if (element.customData?.lcRegionFrame) return false;
  const id = element.id;
  if (id.includes("-label") || id.includes("-hint") || id.includes("-meta")) return false;
  return id.includes("-title") || id.includes("-body-");
}

function isFixedChrome(element: ReadingElement): boolean {
  if (element.customData?.lcFixedSize) return true;
  const id = element.id;
  return id.includes("-label") || id.includes("-hint") || id.includes("-meta");
}

function frameOriginY(
  frames: Map<string, { x: number; y: number }>,
  region: string | undefined,
  fallbackY: number,
): number {
  if (!region) return fallbackY;
  return frames.get(region)?.y ?? fallbackY;
}

function ensureBases(element: ReadingElement, captureFrom: BoardReadingSize): ReadingMeta {
  const meta: ReadingMeta = { ...(element.customData ?? {}) };
  const safe = READING_SCALE[captureFrom] || 1;

  if (typeof element.fontSize === "number" && meta.lcFontBase == null) {
    meta.lcFontBase = element.fontSize / safe;
  }
  if (typeof meta.lcRegionOy === "number" && meta.lcRegionOyBase == null) {
    meta.lcRegionOyBase = meta.lcRegionOy / safe;
  }
  if (typeof element.height === "number" && meta.lcHeightBase == null) {
    meta.lcHeightBase = element.height / safe;
  }
  return meta;
}

/**
 * Undo accidental scaling of labels / hints / tags from older builds.
 */
function restoreChrome<T extends ReadingElement>(
  element: T,
  frames: Map<string, { x: number; y: number }>,
): T {
  const meta = { ...(element.customData ?? {}) };
  const patch: Partial<ReadingElement> = {};
  let changed = false;

  if (typeof meta.lcFontBase === "number" && element.fontSize !== meta.lcFontBase) {
    patch.fontSize = meta.lcFontBase;
    changed = true;
  }
  if (typeof meta.lcRegionOyBase === "number") {
    const oy = meta.lcRegionOyBase;
    const originY = frameOriginY(frames, meta.lcRegion, element.y - (meta.lcRegionOy ?? 0));
    const y = originY + oy;
    if (meta.lcRegionOy !== oy || element.y !== y) {
      patch.y = y;
      meta.lcRegionOy = oy;
      changed = true;
    }
  }
  if (typeof meta.lcHeightBase === "number" && element.height !== meta.lcHeightBase) {
    patch.height = meta.lcHeightBase;
    changed = true;
  }
  if (
    element.type === "rectangle" &&
    typeof meta.lcWidthBase === "number" &&
    element.width !== meta.lcWidthBase
  ) {
    patch.width = meta.lcWidthBase;
    changed = true;
  }

  return changed ? ({ ...element, ...patch, customData: meta } as T) : element;
}

/**
 * Apply reading size to statement title/body. Returns a new list when anything
 * changed; otherwise the same reference.
 */
export function applyBoardReadingSize<T extends ReadingElement>(
  elements: readonly T[],
  size: BoardReadingSize,
  opts?: { captureFrom?: BoardReadingSize },
): T[] {
  const scale = READING_SCALE[size];
  const captureFrom = opts?.captureFrom ?? size;
  const frames = new Map<string, { x: number; y: number }>();
  for (const element of elements) {
    const meta = element.customData;
    if (meta?.lcRegionFrame && meta.lcRegion) {
      frames.set(meta.lcRegion, { x: element.x, y: element.y });
    } else if (element.id.endsWith("-frame")) {
      const match = /^lcregion-([a-z]+)-frame$/i.exec(element.id);
      if (match) frames.set(match[1], { x: element.x, y: element.y });
    }
  }

  // Body stack: keep the first body anchored; scale gaps between body blocks only
  // so tag chips above stay put.
  let bodyAnchor: number | null = null;
  for (const element of elements) {
    if (!element.id.includes("-body-")) continue;
    if (!isReadingContent(element)) continue;
    const meta = ensureBases(element, captureFrom);
    if (typeof meta.lcRegionOyBase === "number") {
      bodyAnchor =
        bodyAnchor == null ? meta.lcRegionOyBase : Math.min(bodyAnchor, meta.lcRegionOyBase);
    }
  }

  let changed = false;
  const next = elements.map((element) => {
    if (isFixedChrome(element)) {
      const restored = restoreChrome(element, frames);
      if (restored !== element) changed = true;
      return restored;
    }
    if (!isReadingContent(element)) return element;

    const meta = ensureBases(element, captureFrom);
    const patch: Partial<ReadingElement> = {};
    let localChanged = false;
    const isBody = element.id.includes("-body-");
    const isTitle = element.id.includes("-title");

    if (typeof meta.lcFontBase === "number") {
      const fontSize = Math.round(meta.lcFontBase * scale * 10) / 10;
      if (element.fontSize !== fontSize) {
        patch.fontSize = fontSize;
        localChanged = true;
      }
    }

    // Title: font only — do not move (tags sit below at fixed positions).
    // Body: scale gaps from the first body so blocks do not overlap when large.
    if (isBody && typeof meta.lcRegionOyBase === "number" && bodyAnchor != null) {
      const oy = Math.round((bodyAnchor + (meta.lcRegionOyBase - bodyAnchor) * scale) * 10) / 10;
      const originY = frameOriginY(frames, meta.lcRegion, element.y - (meta.lcRegionOy ?? 0));
      const y = originY + oy;
      if (meta.lcRegionOy !== oy || element.y !== y) {
        patch.y = y;
        localChanged = true;
      }
      meta.lcRegionOy = oy;
    }

    if (isBody && typeof meta.lcHeightBase === "number") {
      const height = Math.round(meta.lcHeightBase * scale * 10) / 10;
      if (element.height !== height) {
        patch.height = height;
        localChanged = true;
      }
    }

    // Title height tracks font so the frame content-floor stays honest.
    if (isTitle && typeof meta.lcHeightBase === "number") {
      const height = Math.round(meta.lcHeightBase * scale * 10) / 10;
      if (element.height !== height) {
        patch.height = height;
        localChanged = true;
      }
    }

    const metaChanged =
      meta.lcFontBase !== element.customData?.lcFontBase ||
      meta.lcRegionOyBase !== element.customData?.lcRegionOyBase ||
      meta.lcHeightBase !== element.customData?.lcHeightBase ||
      meta.lcRegionOy !== element.customData?.lcRegionOy;

    if (!localChanged && !metaChanged) return element;
    changed = true;
    return { ...element, ...patch, customData: meta } as T;
  });

  return changed ? next : (elements as T[]);
}
