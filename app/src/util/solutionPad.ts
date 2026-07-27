/**
 * Ensure the solution stub has room to type under the entry-point signature.
 * Corpus starters often end right after `def …:` with no blank lines.
 */

import { REGION_MIN } from "../templates/regions";
import { codeLineCanvas, type BoardReadingSize } from "../modes/codeFontSize";

const DEFAULT_BLANK_LINES = 16;

/** Top padding + language chip breathing room inside the frame. */
const CODE_CHROME_CANVAS = 40;
/** Space for the CODE label + hint above the Monaco dock (fixed chrome — not S/M/L). */
export const CODE_LABEL_RESERVE = 104;

/** Trim trailing whitespace, then append blank lines for the implementation. */
export function ensureCodingRoom(source: string, blankLines = DEFAULT_BLANK_LINES): string {
  const trimmed = source.replace(/[ \t]+$/gm, "").replace(/\s+$/u, "");
  if (!trimmed) return "\n".repeat(blankLines);
  return `${trimmed}\n${"\n".repeat(blankLines)}`;
}

/** Label chrome height — region titles do not follow reading size. */
export function codeLabelReserve(_size: BoardReadingSize = "M"): number {
  return CODE_LABEL_RESERVE;
}

/** Canvas height so the Monaco dock can show every line without scrolling. */
export function codeFrameHeightForSource(
  source: string,
  readingSize: BoardReadingSize = "M",
): number {
  const lines = Math.max(1, source.split("\n").length);
  const line = codeLineCanvas(readingSize);
  const label = codeLabelReserve(readingSize);
  return Math.max(
    REGION_MIN.code.minH,
    label + lines * line + CODE_CHROME_CANVAS,
  );
}
