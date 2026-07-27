/**
 * Board reading size (S / M / L).
 *
 * Statement text uses {@link READING_SCALE}. Monaco uses the same ladder times
 * {@link CODE_SIZE_FACTOR} so code stays smaller than the problem statement.
 */

export type BoardReadingSize = "S" | "M" | "L";

export const BOARD_READING_SIZES: BoardReadingSize[] = ["S", "M", "L"];

/**
 * Reference font sizes for the reading ladder (Medium = statement baseline).
 * Statement Excalidraw text scales by {@link READING_SCALE}.
 */
export const READING_FONT_PX: Record<BoardReadingSize, number> = {
  S: 18,
  M: 22,
  L: 28,
};

/** Relative to Medium — problem statement / region chrome. */
export const READING_SCALE: Record<BoardReadingSize, number> = {
  S: READING_FONT_PX.S / READING_FONT_PX.M,
  M: 1,
  L: READING_FONT_PX.L / READING_FONT_PX.M,
};

/**
 * Monaco is this fraction of {@link READING_FONT_PX}.
 * Lower = smaller code relative to the statement.
 */
export const CODE_SIZE_FACTOR = 0.28;

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

/** Monaco font px before zoom. */
export function codeBasePx(size: BoardReadingSize): number {
  return READING_FONT_PX[size] * CODE_SIZE_FACTOR;
}

/**
 * Monaco pixel size at the given board zoom.
 * Tracks board zoom like Excalidraw statement text (no high floor that makes
 * code look huge when the board is zoomed out).
 */
export function codeFontPx(size: BoardReadingSize, zoom: number): number {
  const zoomFactor = Math.min(1.6, Math.max(0.25, zoom));
  return Math.max(8, Math.round(codeBasePx(size) * zoomFactor * 10) / 10);
}

/** Canvas units per code line — keeps the code frame tall enough for Monaco. */
export function codeLineCanvas(size: BoardReadingSize): number {
  return Math.round(codeBasePx(size) * 1.7);
}

// --- Back-compat aliases used by Monaco / older imports ---

export type CodeFontSize = BoardReadingSize;
export const CODE_FONT_SIZES = BOARD_READING_SIZES;
export const loadCodeFontSize = loadBoardReadingSize;
export const saveCodeFontSize = saveBoardReadingSize;
