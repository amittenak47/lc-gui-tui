/**
 * Ensure the solution stub has room to type under the entry-point signature.
 * Corpus starters often end right after `def …:` with no blank lines.
 */

import { REGION_MIN } from "../templates/regions";

const DEFAULT_BLANK_LINES = 16;

/** Monaco ~13px font → ~19px lines; canvas units track CSS px near zoom 1. */
const CODE_LINE_CANVAS = 22;
/** Top padding + language chip breathing room inside the frame. */
const CODE_CHROME_CANVAS = 40;

/** Trim trailing whitespace, then append blank lines for the implementation. */
export function ensureCodingRoom(source: string, blankLines = DEFAULT_BLANK_LINES): string {
  const trimmed = source.replace(/[ \t]+$/gm, "").replace(/\s+$/u, "");
  if (!trimmed) return "\n".repeat(blankLines);
  return `${trimmed}\n${"\n".repeat(blankLines)}`;
}

/** Canvas height so the Monaco dock can show every line without scrolling. */
export function codeFrameHeightForSource(source: string): number {
  const lines = Math.max(1, source.split("\n").length);
  return Math.max(REGION_MIN.code.minH, lines * CODE_LINE_CANVAS + CODE_CHROME_CANVAS);
}
