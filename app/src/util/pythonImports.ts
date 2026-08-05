/**
 * Repair `typing` imports in code a model wrote.
 *
 * Models still answer LeetCode-shaped questions in the 3.5 idiom — `List[int]`,
 * `Optional[TreeNode]` — because that is what a decade of training data looks
 * like, and they do it whether or not they also emit the import. The runtime
 * here is Python 3.12, where the annotation resolves to nothing and the module
 * fails at import time with `NameError: name 'List' is not defined`. The tests
 * do not fail, they never start.
 *
 * Prompting the model to prefer builtin generics is the fix at the source and
 * is done separately; this is the net under it. A net is warranted because the
 * failure is total, the repair is unambiguous — a bare `List[` with no binding
 * for `List` can only mean `typing.List` — and the alternative is the student
 * typing the same import by hand every time, which is exactly what happened.
 */

/** `typing` names worth repairing: the ones a subscripted annotation implies. */
const TYPING_NAMES = [
  "List",
  "Dict",
  "Set",
  "Tuple",
  "Optional",
  "Any",
  "Callable",
  "Iterable",
  "Iterator",
  "Sequence",
  "Mapping",
  "Union",
  "DefaultDict",
  "Deque",
  "FrozenSet",
  "Counter",
] as const;

/** Already bound in this module — by any import shape a person actually writes. */
function isAlreadyImported(code: string, name: string): boolean {
  if (new RegExp(`^\\s*from\\s+typing\\s+import\\s+\\*`, "m").test(code)) return true;
  // `from typing import List, Optional` — including parenthesised continuations.
  const fromTyping = new RegExp(
    `^\\s*from\\s+typing(?:_extensions)?\\s+import\\s+[^\\n]*(?<![\\w])${name}(?![\\w])`,
    "m",
  );
  if (fromTyping.test(code)) return true;
  // `import typing` then `typing.List[...]` — the annotation would be qualified,
  // so a bare `List[` still needs its own binding and this does not count.
  // A local class or assignment of the same name does, though.
  const localBinding = new RegExp(`^\\s*(?:class|def)\\s+${name}\\b|^\\s*${name}\\s*=`, "m");
  return localBinding.test(code);
}

/** Names used as subscripted annotations but never bound. */
export function missingTypingNames(code: string): string[] {
  return TYPING_NAMES.filter(
    (name) =>
      new RegExp(`(?<![\\w.])${name}\\s*\\[`).test(code) && !isAlreadyImported(code, name),
  );
}

/**
 * The code with any missing `typing` import added.
 *
 * Inserted after the module docstring and any `from __future__` line, which are
 * the only two things Python requires to come first — putting it at the very
 * top would move a docstring out of position and turn it into a bare string
 * expression, and would be a syntax error after `from __future__`.
 */
export function ensureTypingImports(code: string): string {
  const missing = missingTypingNames(code);
  if (missing.length === 0) return code;

  const lines = code.split("\n");
  let insertAt = 0;

  // A module docstring, however it is quoted, and however many lines it runs to.
  const firstCode = lines.findIndex((line) => line.trim().length > 0);
  if (firstCode >= 0) {
    const opener = lines[firstCode].trim();
    const quote = opener.startsWith('"""') ? '"""' : opener.startsWith("'''") ? "'''" : null;
    if (quote) {
      const singleLine = opener.length >= 6 && opener.endsWith(quote);
      if (singleLine) {
        insertAt = firstCode + 1;
      } else {
        for (let i = firstCode + 1; i < lines.length; i += 1) {
          if (lines[i].includes(quote)) {
            insertAt = i + 1;
            break;
          }
        }
      }
    }
  }

  // `from __future__ import …` must precede every other import.
  for (let i = insertAt; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("from __future__")) insertAt = i + 1;
    else if (lines[i].trim().length > 0) break;
  }

  lines.splice(insertAt, 0, `from typing import ${missing.join(", ")}`);
  return lines.join("\n");
}
