/**
 * Board reading size (S / M / L).
 *
 * Statement body uses scene font sizes from {@link BODY_FONT_PX}; canvas zoom
 * then magnifies the whole board together. Monaco uses {@link CODE_FONT_PX} ×
 * zoom so the docked editor stays proportional to the statement.
 */

export type BoardReadingSize = "S" | "M" | "L";

export const BOARD_READING_SIZES: BoardReadingSize[] = ["S", "M", "L"];

/** Statement body scene font (prose). Code samples in the statement stay ~86%. */
export const BODY_FONT_PX: Record<BoardReadingSize, number> = {
  S: 28,
  M: 36,
  L: 44,
};

/** Prose lineHeight / fontSize — matches problemBoard template (40 / 28). */
export const STATEMENT_LINE_HEIGHT_RATIO = 40 / 28;

/** Scene-space distance between lined-paper rules / statement baselines. */
export function statementLinePitch(size: BoardReadingSize): number {
  return BODY_FONT_PX[size] * STATEMENT_LINE_HEIGHT_RATIO;
}

/** Monaco CSS px at zoom 1 — close to statement body so they track together. */
export const CODE_FONT_PX: Record<BoardReadingSize, number> = {
  S: 16,
  M: 20,
  L: 24,
};

/** Relative to Medium — used by tests / legacy helpers. */
export const READING_SCALE: Record<BoardReadingSize, number> = {
  S: BODY_FONT_PX.S / BODY_FONT_PX.M,
  M: 1,
  L: BODY_FONT_PX.L / BODY_FONT_PX.M,
};

const STORAGE_KEY = "lc-board-reading-size";

export function loadBoardReadingSize(): BoardReadingSize {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("lc-code-font-size");
    if (raw === "S" || raw === "M" || raw === "L") return raw;
  } catch {
    /* ignore */
  }
  return "M";
}

export function saveBoardReadingSize(size: BoardReadingSize): void {
  try {
    localStorage.setItem(STORAGE_KEY, size);
    localStorage.setItem("lc-code-font-size", size);
  } catch {
    /* ignore */
  }
}

/** Monaco font size in CSS px — scales with board zoom so code tracks statement text. */
export function codeFontPx(size: BoardReadingSize, zoom = 1): number {
  const base = CODE_FONT_PX[size];
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  // Keep it readable when fitView zooms far out; cap so extreme zoom-in stays usable.
  return Math.max(11, Math.min(36, Math.round(base * z)));
}

/** Canvas units per code line for frame height. */
export function codeLineCanvas(size: BoardReadingSize): number {
  return Math.round(CODE_FONT_PX[size] * 1.55);
}

export type CodeFontSize = BoardReadingSize;
export const CODE_FONT_SIZES = BOARD_READING_SIZES;
export const READING_FONT_PX = BODY_FONT_PX;
export const loadCodeFontSize = loadBoardReadingSize;
export const saveCodeFontSize = saveBoardReadingSize;
