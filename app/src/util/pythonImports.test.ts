import { describe, expect, it } from "vitest";

import { ensureTypingImports, missingTypingNames } from "./pythonImports";

describe("missingTypingNames", () => {
  it("finds a bare annotation the model left unimported", () => {
    expect(missingTypingNames("def f(a: List[int]) -> int: ...")).toEqual(["List"]);
  });

  it("says nothing when the import is already there", () => {
    const code = "from typing import List\n\ndef f(a: List[int]) -> int: ...";
    expect(missingTypingNames(code)).toEqual([]);
  });

  it("handles a multi-name import line", () => {
    const code = "from typing import Dict, List, Optional\nx: Optional[List[int]] = None";
    expect(missingTypingNames(code)).toEqual([]);
  });

  it("respects a star import", () => {
    expect(missingTypingNames("from typing import *\nx: List[int] = []")).toEqual([]);
  });

  it("ignores builtin generics, which need nothing", () => {
    expect(missingTypingNames("def f(a: list[int]) -> dict[str, int]: ...")).toEqual([]);
  });

  it("does not fire on an attribute or a subscripted local", () => {
    expect(missingTypingNames("x = obj.List[0]")).toEqual([]);
    expect(missingTypingNames("List = [1, 2]\ny = List[0]")).toEqual([]);
  });

  it("catches several at once", () => {
    const found = missingTypingNames("def f(a: List[int], b: Dict[str, Optional[int]]): ...");
    expect(found).toEqual(["List", "Dict", "Optional"]);
  });
});

describe("ensureTypingImports", () => {
  it("adds the import a model left out", () => {
    expect(ensureTypingImports("def f(a: List[int]): ...")).toBe(
      "from typing import List\ndef f(a: List[int]): ...",
    );
  });

  it("leaves correct code untouched", () => {
    const code = "from typing import List\n\ndef f(a: List[int]): ...";
    expect(ensureTypingImports(code)).toBe(code);
  });

  it("goes under a module docstring, not above it", () => {
    const out = ensureTypingImports('"""Solution."""\n\ndef f(a: List[int]): ...');
    // Above the docstring would demote it to a bare string expression.
    expect(out.startsWith('"""Solution."""')).toBe(true);
    expect(out).toContain("from typing import List");
  });

  it("goes under a multi-line docstring", () => {
    const out = ensureTypingImports('"""Long\n\nexplanation.\n"""\ndef f(a: Set[int]): ...');
    expect(out.split("\n")[0]).toBe('"""Long');
    expect(out.indexOf("from typing import Set")).toBeGreaterThan(out.indexOf("explanation."));
  });

  it("stays after `from __future__`, which must come first", () => {
    const out = ensureTypingImports("from __future__ import annotations\ndef f(a: List[int]): ...");
    expect(out.split("\n")[0]).toBe("from __future__ import annotations");
    expect(out.split("\n")[1]).toBe("from typing import List");
  });
});
