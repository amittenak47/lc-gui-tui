/**
 * Ensure the solution stub has room to type under the entry-point signature.
 * Corpus starters often end right after `def …:` with no blank lines.
 */

const DEFAULT_BLANK_LINES = 16;

/** Trim trailing whitespace, then append blank lines for the implementation. */
export function ensureCodingRoom(source: string, blankLines = DEFAULT_BLANK_LINES): string {
  const trimmed = source.replace(/[ \t]+$/gm, "").replace(/\s+$/u, "");
  if (!trimmed) return "\n".repeat(blankLines);
  return `${trimmed}\n${"\n".repeat(blankLines)}`;
}
