/**
 * Splitting `solution.py` into the part the student was handed and the part
 * they write.
 *
 * Two consumers, two cuts:
 *
 * - **Editor tabs** ({@link splitSolution}): cut before `class Solution:`.
 *   *Imports* = header comments, imports, helper classes (`ListNode`, …).
 *   *Solution* = the `class Solution` block (signature + body + any helpers
 *   the student adds underneath).
 *
 * - **Review wire** ({@link skeletonOf}): cut under the entry-point signature.
 *   A code delta is anchored to that skeleton, so editing an import *or* the
 *   signature must be detectable — hashing only the Imports tab would miss a
 *   renamed parameter.
 *
 * When the shape is not the corpus's, both return a conservative fallback
 * (null / whole file) and callers treat the buffer as one undivided blob.
 */

export interface SolutionSplit {
  /** Header comments, imports, helper classes — everything above `class Solution`. */
  skeleton: string;
  /** `class Solution:` and everything under it — signature, body, student helpers. */
  body: string;
}

/** Does this line open a method? */
function isDefLine(line: string): boolean {
  return /^\s*(async\s+)?def\s+\w+\s*\(/.test(line);
}

/**
 * Index of the line that closes a signature starting at `start`.
 *
 * Signatures wrap — corpus starters annotate types and run past the margin, so
 * the closing `:` is often several lines below the `def`. Counting brackets is
 * what distinguishes that from a `def` whose body starts on the next line.
 */
function signatureEnd(lines: readonly string[], start: number): number | null {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    let quote: string | null = null;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (quote) {
        if (ch === "\\") c++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "#") break; // Trailing comment — not part of the signature.
      else if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
    }
    if (depth <= 0 && /:\s*(#.*)?$/.test(line)) return i;
  }
  return null;
}

/**
 * Editor-tab split: Imports (above `class Solution`) vs Solution (the class).
 *
 * Returns null when there is no `class Solution` — a cleared buffer, or one the
 * student reshaped past the corpus layout. Callers then show one undivided pane.
 */
export function splitSolution(source: string): SolutionSplit | null {
  const lines = source.split("\n");
  const solutionClass = lines.findIndex((line) => /^\s*class\s+Solution\b/.test(line));
  if (solutionClass < 0) return null;
  return {
    skeleton: lines.slice(0, solutionClass).join("\n"),
    body: lines.slice(solutionClass).join("\n"),
  };
}

/** Put the two tab halves back together. Inverse of {@link splitSolution}. */
export function joinSolution(skeleton: string, body: string): string {
  if (skeleton.length === 0) return body;
  if (body.length === 0) return skeleton;
  return `${skeleton}\n${body}`;
}

/**
 * Wire-anchor skeleton: everything through the entry-point signature.
 *
 * The entry point is the *first* `def` at or below `class Solution:` — which is
 * neither the first `def` in the file nor the last. Corpus starters put helper
 * classes (`ListNode`, `TreeNode`) and their `__init__` above `class Solution`,
 * so the first `def` overall belongs to the handed preamble. Students add their
 * own helper methods underneath the entry point, so taking the last `def` would
 * make a helper's signature jump the anchor mid-keystroke.
 *
 * Falls back to the whole source when there is no split — an unsplittable file
 * is one the student has reshaped, and treating all of it as skeleton means any
 * edit forces a full send. Conservative in the safe direction.
 */
export function skeletonOf(source: string): string {
  const lines = source.split("\n");
  const solutionClass = lines.findIndex((line) => /^\s*class\s+Solution\b/.test(line));
  const start = solutionClass >= 0 ? solutionClass : 0;

  for (let i = start; i < lines.length; i++) {
    if (!isDefLine(lines[i])) continue;
    const end = signatureEnd(lines, i);
    if (end === null) return source;
    return lines.slice(0, end + 1).join("\n");
  }
  return source;
}
