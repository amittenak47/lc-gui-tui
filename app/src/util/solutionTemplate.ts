/**
 * Pick the right editor source when opening a problem.
 *
 * Corpus `prompt` often ships a kitchen-sink preamble (ListNode, TreeNode, …)
 * even for array problems. The daemon now filters that down in `starter_code`,
 * but an older `solution.py` on disk can still carry leftovers. Prefer the
 * fresh template unless the student has already written a real Solution body.
 */

const SOLUTION_CLASS = /^class\s+Solution\b/m;

/** Top-level `class Foo` names in a Python stub (excluding indented nested classes). */
export function helperClassNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/^class\s+(\w+)/gm)) {
    names.add(match[1]);
  }
  return names;
}

/** Slice from `class Name` through the line before the next top-level class (or EOF). */
export function extractTopLevelClass(source: string, name: string): string | null {
  const re = new RegExp(`^class\\s+${name}\\b[^\\n]*\\n`, "m");
  const match = re.exec(source);
  if (!match || match.index === undefined) return null;
  const start = match.index;
  const rest = source.slice(start + match[0].length);
  const next = /^class\s+\w+/m.exec(rest);
  const end = next ? start + match[0].length + (next.index ?? 0) : source.length;
  return source.slice(start, end).replace(/\s+$/u, "");
}

/** Everything before `class Solution`, trimmed. */
export function preambleBeforeSolution(source: string): string {
  const match = SOLUTION_CLASS.exec(source);
  if (!match || match.index === undefined) return source.replace(/\s+$/u, "");
  return source.slice(0, match.index).replace(/\s+$/u, "");
}

/** True when the Solution body is still a stub (`pass`, `...`, or empty). */
export function isSolutionStub(solutionClass: string): boolean {
  const body = solutionClass.replace(/^class\s+Solution\b[^\n]*\n/, "");
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("def "));
  if (lines.length === 0) return true;
  return lines.every((line) => line === "pass" || line === "..." || line === "ellipsis");
}

/**
 * Use the fresh corpus template when disk helpers are stale; keep a real
 * student Solution body when they have started coding.
 */
export function resolveSolutionSource(fresh: string, disk: string): string {
  const diskTrim = disk.replace(/\s+$/u, "");
  const freshTrim = fresh.replace(/\s+$/u, "");
  if (!diskTrim) return freshTrim;

  const freshHelpers = helperClassNames(freshTrim);
  const diskHelpers = helperClassNames(diskTrim);
  const stale = [...diskHelpers].filter(
    (name) => name !== "Solution" && !freshHelpers.has(name),
  );

  if (stale.length === 0) return diskTrim;

  const diskSol = extractTopLevelClass(diskTrim, "Solution");
  const freshSol = extractTopLevelClass(freshTrim, "Solution");
  const freshPre = preambleBeforeSolution(freshTrim);

  if (diskSol && freshSol && !isSolutionStub(diskSol)) {
    if (!freshPre) return diskSol;
    return `${freshPre}\n\n\n${diskSol}`;
  }
  return freshTrim;
}
