/**
 * Scale problem-statement **body** text for the board reading size (S/M/L).
 *
 * Scales only `lcregion-constraints-body-*` scene font sizes.
 * Leaves alone: region labels, problem title, difficulty/tag chips, hints, frames.
 *
 * Canvas zoom is independent — Excalidraw magnifies everything together.
 * Monaco scales its CSS px by the same zoom so the dock stays proportional.
 */

import {
  regionTextWidth,
  STATEMENT_BASE_RANGE,
  STATEMENT_CODE_BASE,
  STATEMENT_PROSE_BASE,
} from "../templates/readingColumn";
import { FONT_CODE, FONT_UI } from "../templates/skeleton";
import {
  BODY_FONT_PX,
  statementSceneFont,
  STATEMENT_LINE_HEIGHT_RATIO,
  type BoardReadingSize,
} from "./codeFontSize";
import { linedRuleClearance, textBaselineOffset } from "./textBaseline";

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
  fontFamily?: number;
  /** Excalidraw lineHeight multiplier (line box / fontSize). */
  lineHeight?: number;
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

/**
 * The base a statement block is *authored* at, healed onto the reading-column
 * scale.
 *
 * The base only survives to carry one fact — is this block prose or an example
 * — and boards saved under the old four-screen-wide column carry bases (28/24,
 * or a compounded 36/44) that mean nothing on a column a tenth as wide. Out of
 * range, the face is the better witness than the number.
 */
function healedBase(element: ReadingElement, stored: number | undefined): number {
  const [lo, hi] = STATEMENT_BASE_RANGE;
  if (typeof stored === "number" && stored >= lo && stored <= hi) return stored;
  const family =
    element.fontFamily ?? (typeof stored === "number" && stored < 26 ? FONT_CODE : FONT_UI);
  return family === FONT_CODE ? STATEMENT_CODE_BASE : STATEMENT_PROSE_BASE;
}

function ensureBases(element: ReadingElement): ReadingMeta {
  const meta: ReadingMeta = { ...(element.customData ?? {}) };

  meta.lcFontBase = healedBase(
    element,
    typeof meta.lcFontBase === "number" ? meta.lcFontBase : element.fontSize,
  );
  if (typeof meta.lcRegionOy === "number" && meta.lcRegionOyBase == null) {
    meta.lcRegionOyBase = meta.lcRegionOy;
  }
  if (meta.lcLineHeightBase == null) {
    const family = element.fontFamily ?? FONT_UI;
    meta.lcLineHeightBase = family === FONT_CODE ? 1.42 : STATEMENT_LINE_HEIGHT_RATIO;
  }
  return meta;
}

function restoreChrome<T extends ReadingElement>(
  element: T,
  frames: Map<string, { x: number; y: number; width?: number }>,
  /**
   * How much the statement's type had to shrink to come out at the reading
   * size on this screen. Chrome is scaled by the same factor so the title
   * stays the same size to the reader — without it the title is *larger* on a
   * tablet than on a phone, since only the body follows the fit.
   */
  chromeScale = 1,
): T {
  const meta = { ...(element.customData ?? {}) };
  const patch: Partial<ReadingElement> = {};
  let changed = false;

  if (typeof meta.lcFontBase === "number") {
    const scaled = Math.round(meta.lcFontBase * chromeScale * 10) / 10;
    if (element.fontSize !== scaled) {
      patch.fontSize = scaled;
      changed = true;
    }
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
  /** Snap body blocks onto the lined-paper pitch so statement text sits on the rules. */
  lined?: boolean;
  /**
   * Board content width in CSS pixels.
   *
   * The statement page is a reading column fitted to this width, so this is
   * what turns the S/M/L *reading* size into a scene font. Omitted (or zero)
   * means "not measured": the column is then treated as full-bleed, which is
   * both the phone case and the conservative one.
   */
  viewportWidth?: number;
}

/**
 * Apply reading size to statement body blocks. Returns a new list when anything
 * changed; otherwise the same reference.
 */
export function applyBoardReadingSize<T extends ReadingElement>(
  elements: readonly T[],
  size: BoardReadingSize,
  opts?: ApplyReadingOpts,
): T[] {
  const lined = Boolean(opts?.lined);

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

  /*
   * The reading column decides the type size, so it is measured first.
   *
   * `targetFont` used to be a constant per S/M/L. That was right when the
   * statement lived in a fixed 3920-unit frame and wrong the moment the frame
   * became a column sized to the screen: the same 36 units is 36 CSS px on a
   * phone-width column and 3.6 on a desk-width one. Deriving it from the column
   * and the viewport is what makes S/M/L name a size the reader can see.
   */
  const constraintsW = frameWidth(frames, "constraints");
  const textWidth = constraintsW != null ? regionTextWidth(constraintsW) : null;
  const targetFont =
    constraintsW != null
      ? statementSceneFont(size, constraintsW, opts?.viewportWidth ?? 0)
      : BODY_FONT_PX[size];
  const gridPitch = targetFont * STATEMENT_LINE_HEIGHT_RATIO;
  const chromeScale = targetFont / STATEMENT_PROSE_BASE;

  const bodies = elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => isBody(element));

  let bodyAnchor: number | null = null;
  let bodyBaselineAnchor: number | null = null;
  for (const { element } of bodies) {
    const meta = ensureBases(element);
    if (typeof meta.lcRegionOyBase === "number") {
      bodyAnchor =
        bodyAnchor == null ? meta.lcRegionOyBase : Math.min(bodyAnchor, meta.lcRegionOyBase);
      const baseFont = meta.lcFontBase ?? STATEMENT_PROSE_BASE;
      const lhBase = meta.lcLineHeightBase ?? STATEMENT_LINE_HEIGHT_RATIO;
      const fontFamily = element.fontFamily ?? FONT_UI;
      const baseline =
        meta.lcRegionOyBase +
        textBaselineOffset(baseFont, lhBase, fontFamily);
      bodyBaselineAnchor =
        bodyBaselineAnchor == null
          ? baseline
          : Math.min(bodyBaselineAnchor, baseline);
    }
  }
  if (bodyAnchor == null) bodyAnchor = 200;
  if (bodyBaselineAnchor == null) {
    bodyBaselineAnchor =
      bodyAnchor +
      textBaselineOffset(targetFont, STATEMENT_LINE_HEIGHT_RATIO, FONT_UI);
  }

  const bodyPatch = new Map<
    number,
    { element: T; meta: ReadingMeta; patch: Partial<ReadingElement> }
  >();
  let cursor = bodyAnchor;
  let baselineCursor = Math.round(bodyBaselineAnchor / gridPitch) * gridPitch;
  const gap = Math.round(targetFont * 0.78);

  for (const { element, index } of bodies) {
    const meta = ensureBases(element);
    const baseFont = meta.lcFontBase ?? STATEMENT_PROSE_BASE;
    // Preserve the code vs prose ratio the template authored.
    const ratio = Math.min(1.05, Math.max(0.8, baseFont / STATEMENT_PROSE_BASE));
    const fontSize = Math.round(targetFont * ratio * 10) / 10;
    // Lined mode uses a shared prose pitch so rules match every body line.
    const lhRatio = lined
      ? STATEMENT_LINE_HEIGHT_RATIO
      : (meta.lcLineHeightBase ?? STATEMENT_LINE_HEIGHT_RATIO);
    const lineH = lined ? gridPitch : fontSize * lhRatio;
    const fontFamily = element.fontFamily ?? FONT_UI;
    const baselineOffset = textBaselineOffset(fontSize, lhRatio, fontFamily);
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
    const oy = lined
      ? baselineCursor - linedRuleClearance(fontSize) - baselineOffset
      : cursor;
    const y = originY + oy;

    const patch: Partial<ReadingElement> = {};
    if (element.fontSize !== fontSize) patch.fontSize = fontSize;
    if (element.lineHeight !== lhRatio) patch.lineHeight = lhRatio;
    if (element.y !== y) patch.y = y;
    if (element.height !== height) patch.height = height;
    if (textWidth != null && element.width !== textWidth) patch.width = textWidth;
    meta.lcRegionOy = oy;

    bodyPatch.set(index, { element, meta, patch });
    if (lined) {
      baselineCursor += wrappedLines * gridPitch;
    } else {
      cursor = oy + height + gap;
    }
  }

  let changed = false;
  const next = elements.map((element, index) => {
    if (isFixedChrome(element)) {
      const restored = restoreChrome(
        element,
        frames,
        element.customData?.lcRegion === "constraints" ? chromeScale : 1,
      );
      if (restored !== element) changed = true;
      return restored;
    }

    const planned = bodyPatch.get(index);
    if (!planned) return element;

    const { meta, patch } = planned;
    if (
      Object.keys(patch).length === 0 &&
      meta.lcRegionOy === element.customData?.lcRegionOy
    ) {
      return element;
    }
    changed = true;
    return { ...element, ...patch, customData: meta } as T;
  });

  return changed ? next : (elements as T[]);
}
