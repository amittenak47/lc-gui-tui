/**
 * Board reading size (S / M / L).
 *
 * Statement body uses scene font sizes from {@link BODY_FONT_PX}; canvas zoom
 * then magnifies the whole board together. Monaco uses {@link CODE_FONT_PX} in
 * CSS px and ignores zoom.
 */

export type BoardReadingSize = "S" | "M" | "L";

export const BOARD_READING_SIZES: BoardReadingSize[] = ["S", "M", "L"];

/** Statement body scene font (prose). Code samples in the statement stay ~86%. */
export const BODY_FONT_PX: Record<BoardReadingSize, number> = {
  S: 20,
  M: 24,
  L: 28,
};

/** Monaco CSS px — independent of board zoom. */
export const CODE_FONT_PX: Record<BoardReadingSize, number> = {
  S: 12,
  M: 14,
  L: 16,
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

/** Monaco font size in CSS px (ignores board zoom). */
export function codeFontPx(size: BoardReadingSize, _zoom?: number): number {
  return CODE_FONT_PX[size];
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
