/**
 * Splitting `solution.py` into the part the student was handed and the part
 * they write.
 *
 * Two things need this. The editor shows them as separate tabs so the method
 * body is not buried under a header comment and a type-annotated signature on a
 * tablet-sized screen. And the review wire needs a hash of *just* the skeleton:
 * a delta is anchored to the skeleton the server last acknowledged, so editing
 * an import has to be detectable — hashing the whole file cannot tell "added a
 * `defaultdict` import" from "wrote another line of the loop".
 *
 * The split is deliberately conservative. When the shape is not the corpus's
 * (no `class`/`def`, a cleared file, a student who rewrote it as a bare
 * function), {@link splitSolution} returns null and callers fall back to
 * treating the file as one undivided blob — which is what they did before.
 */

export interface SolutionSplit {
  /** Header comments, imports, helper classes, `class Solution:` and the signature. */
  skeleton: string;
  /** Everything under the entry-point signature — the student's work. */
  body: string;
}

/** Does this line open the entry-point method? */
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
 * Split under the entry-point signature, or null when there is nothing to split.
 *
 * The entry point is the *first* `def` at or below `class Solution:` — which is
 * neither the first `def` in the file nor the last. Corpus starters put helper
 * classes (`ListNode`, `TreeNode`) and their `__init__` above `class Solution`,
 * so the first `def` overall belongs to the skeleton. And students add their own
 * helper methods underneath the entry point, so taking the last `def` would make
 * a helper's signature jump out of the tab they were typing it in.
 */
export function splitSolution(source: string): SolutionSplit | null {
  const lines = source.split("\n");
  const solutionClass = lines.findIndex((line) => /^\s*class\s+Solution\b/.test(line));
  const start = solutionClass >= 0 ? solutionClass : 0;

  for (let i = start; i < lines.length; i++) {
    if (!isDefLine(lines[i])) continue;
    const end = signatureEnd(lines, i);
    if (end === null) return null;
    return {
      skeleton: lines.slice(0, end + 1).join("\n"),
      body: lines.slice(end + 1).join("\n"),
    };
  }
  return null;
}

/** Put the two halves back together. Inverse of {@link splitSolution}. */
export function joinSolution(skeleton: string, body: string): string {
  return body.length > 0 ? `${skeleton}\n${body}` : skeleton;
}

/**
 * The part of the file a code delta is anchored to.
 *
 * Falls back to the whole source when there is no split — an unsplittable file
 * is one the student has reshaped, and treating all of it as skeleton means any
 * edit forces a full send. Conservative in the safe direction.
 */
export function skeletonOf(source: string): string {
  return splitSolution(source)?.skeleton ?? source;
}
