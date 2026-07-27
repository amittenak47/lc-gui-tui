/**
 * Scale problem-statement **body** text for the board reading size (S/M/L).
 *
 * Scales only `lcregion-constraints-body-*` scene font sizes.
 * Leaves alone: region labels, problem title, difficulty/tag chips, hints, frames.
 *
 * Canvas zoom is independent — Excalidraw magnifies everything together.
 * (Monaco uses separate CSS px via {@link codeFontPx}.)
 */

import { BODY_FONT_PX, type BoardReadingSize } from "./codeFontSize";

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
  lcLineHeightBase?: number;
};

export type ReadingElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  fontSize?: number;
  text?: string;
  customData?: ReadingMeta | null;
};

function isBody(element: ReadingElement): boolean {
  if (element.customData?.lcVizId) return false;
  if (element.customData?.lcFixedSize) return false;
  if (element.customData?.lcRegionFrame) return false;
  return element.id.includes("-body-");
}

function isFixedChrome(element: ReadingElement): boolean {
  if (element.customData?.lcFixedSize) return true;
  const id = element.id;
  return (
    id.includes("-label") ||
    id.includes("-hint") ||
    id.includes("-meta") ||
    id.includes("-title")
  );
}

function frameOriginY(
  frames: Map<string, { x: number; y: number }>,
  region: string | undefined,
  fallbackY: number,
): number {
  if (!region) return fallbackY;
  return frames.get(region)?.y ?? fallbackY;
}

function frameWidth(
  frames: Map<string, { x: number; y: number; width?: number }>,
  region: string | undefined,
): number | null {
  if (!region) return null;
  const frame = frames.get(region);
  return typeof frame?.width === "number" ? frame.width : null;
}

function ensureBases(element: ReadingElement): ReadingMeta {
  const meta: ReadingMeta = { ...(element.customData ?? {}) };

  if (typeof element.fontSize === "number" && meta.lcFontBase == null) {
    // Prefer template sizes (24 code / 28 prose). Heal compounded bases.
    const raw = element.fontSize;
    meta.lcFontBase = raw > 42 ? 28 : raw < 12 ? 28 : raw;
  }
  if (typeof meta.lcFontBase === "number" && meta.lcFontBase > 42) {
    meta.lcFontBase = 28;
  }
  if (typeof meta.lcRegionOy === "number" && meta.lcRegionOyBase == null) {
    meta.lcRegionOyBase = meta.lcRegionOy;
  }
  if (meta.lcLineHeightBase == null) {
    const base = meta.lcFontBase ?? 28;
    meta.lcLineHeightBase = base < 26 ? 34 / 24 : 40 / 28;
  }
  return meta;
}

function restoreChrome<T extends ReadingElement>(
  element: T,
  frames: Map<string, { x: number; y: number; width?: number }>,
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

export interface ApplyReadingOpts {
  captureFrom?: BoardReadingSize;
  /** Ignored — kept for call-site compatibility. Zoom no longer counter-scales fonts. */
  zoom?: number;
}

/**
 * Apply reading size to statement body blocks. Returns a new list when anything
 * changed; otherwise the same reference.
 */
export function applyBoardReadingSize<T extends ReadingElement>(
  elements: readonly T[],
  size: BoardReadingSize,
  _opts?: ApplyReadingOpts,
): T[] {
  const targetFont = BODY_FONT_PX[size];

  const frames = new Map<string, { x: number; y: number; width?: number }>();
  for (const element of elements) {
    const meta = element.customData;
    if (meta?.lcRegionFrame && meta.lcRegion) {
      frames.set(meta.lcRegion, { x: element.x, y: element.y, width: element.width });
    } else if (element.id.endsWith("-frame")) {
      const match = /^lcregion-([a-z]+)-frame$/i.exec(element.id);
      if (match) frames.set(match[1], { x: element.x, y: element.y, width: element.width });
    }
  }

  const bodies = elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => isBody(element));

  let bodyAnchor: number | null = null;
  for (const { element } of bodies) {
    const meta = ensureBases(element);
    if (typeof meta.lcRegionOyBase === "number") {
      bodyAnchor =
        bodyAnchor == null ? meta.lcRegionOyBase : Math.min(bodyAnchor, meta.lcRegionOyBase);
    }
  }
  if (bodyAnchor == null) bodyAnchor = 200;

  const bodyPatch = new Map<
    number,
    { element: T; meta: ReadingMeta; patch: Partial<ReadingElement> }
  >();
  let cursor = bodyAnchor;
  const gap = 22;
  const constraintsW = frameWidth(frames, "constraints");
  const textWidth =
    constraintsW != null ? Math.max(200, constraintsW - 72) : null;

  for (const { element, index } of bodies) {
    const meta = ensureBases(element);
    const baseFont = meta.lcFontBase ?? 28;
    // Preserve code vs prose ratio from the template (24 vs 28).
    const ratio = Math.min(1.05, Math.max(0.8, baseFont / 28));
    const fontSize = Math.round(targetFont * ratio * 10) / 10;
    const lhRatio = meta.lcLineHeightBase ?? 40 / 28;
    const lineH = fontSize * lhRatio;
    // Approximate soft-wrap: chars per line shrinks as font grows.
    const wrapWidth = textWidth ?? element.width ?? 800;
    const avgChar = fontSize * 0.55;
    const charsPerLine = Math.max(12, Math.floor(wrapWidth / avgChar));
    const raw = String(element.text ?? "");
    let wrappedLines = 0;
    for (const paragraph of raw.split("\n")) {
      wrappedLines += Math.max(1, Math.ceil(Math.max(1, paragraph.length) / charsPerLine));
    }
    const height = Math.round(wrappedLines * lineH * 10) / 10;
    const originY = frameOriginY(frames, meta.lcRegion, element.y - (meta.lcRegionOy ?? 0));
    const oy = cursor;
    const y = originY + oy;

    const patch: Partial<ReadingElement> = {};
    if (element.fontSize !== fontSize) patch.fontSize = fontSize;
    if (element.y !== y) patch.y = y;
    if (element.height !== height) patch.height = height;
    if (textWidth != null && element.width !== textWidth) patch.width = textWidth;
    meta.lcRegionOy = oy;

    bodyPatch.set(index, { element, meta, patch });
    cursor = oy + height + gap;
  }

  let changed = false;
  const next = elements.map((element, index) => {
    if (isFixedChrome(element)) {
      const restored = restoreChrome(element, frames);
      if (restored !== element) changed = true;
      return restored;
    }

    const planned = bodyPatch.get(index);
    if (!planned) return element;

    const { meta, patch } = planned;
    if (Object.keys(patch).length === 0 && meta.lcRegionOy === element.customData?.lcRegionOy) {
      return element;
    }
    changed = true;
    return { ...element, ...patch, customData: meta } as T;
  });

  return changed ? next : (elements as T[]);
}
