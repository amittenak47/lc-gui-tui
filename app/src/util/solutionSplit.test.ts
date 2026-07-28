import { describe, expect, it } from "vitest";

import { joinSolution, skeletonOf, splitSolution } from "./solutionSplit";

/** The shape `lc load` writes: header comments, then the corpus's code body. */
const STARTER = [
  "# lc workspace — task: two-sum · LeetCode #1 · Easy",
  "# Entry point: twoSum — keep the name and signature; `lc test` calls it directly.",
  "",
  "from typing import List",
  "",
  "class Solution:",
  "    def twoSum(self, nums: List[int], target: int) -> List[int]:",
  "        ",
].join("\n");

describe("splitSolution", () => {
  it("cuts under the entry-point signature", () => {
    const split = splitSolution(STARTER)!;
    expect(split.skeleton.endsWith("-> List[int]:")).toBe(true);
    expect(split.skeleton).toContain("from typing import List");
    expect(split.body).toBe("        ");
  });

  it("keeps a wrapped signature whole", () => {
    // Corpus starters annotate types and run past the margin, so the closing
    // `:` is often several lines below the `def`.
    const source = [
      "class Solution:",
      "    def merge(",
      "        self,",
      "        intervals: List[List[int]],",
      "    ) -> List[List[int]]:",
      "        return []",
    ].join("\n");
    const split = splitSolution(source)!;
    expect(split.skeleton.endsWith(") -> List[List[int]]:")).toBe(true);
    expect(split.body).toBe("        return []");
  });

  it("is not fooled by a colon inside the signature's own text", () => {
    const source = [
      "class Solution:",
      "    def f(self, sep: str = ':') -> str:  # split on ':'",
      "        return sep",
    ].join("\n");
    const split = splitSolution(source)!;
    expect(split.body).toBe("        return sep");
  });

  it("splits at the entry point, not at a helper class above it", () => {
    // Starters put ListNode/TreeNode and their __init__ above class Solution,
    // so the first `def` in the file is skeleton, not the entry point.
    const source = [
      "class ListNode:",
      "    def __init__(self, val=0, next=None):",
      "        self.val = val",
      "        self.next = next",
      "",
      "class Solution:",
      "    def reverseList(self, head):",
      "        prev = None",
      "        return prev",
    ].join("\n");
    const split = splitSolution(source)!;
    expect(split.skeleton).toContain("class ListNode:");
    expect(split.skeleton).toContain("self.next = next");
    expect(split.skeleton.endsWith("def reverseList(self, head):")).toBe(true);
    expect(split.body).toBe("        prev = None\n        return prev");
  });

  it("splits at the entry point, not at a helper the student added below", () => {
    // Taking the last `def` would make a helper's signature jump out of the
    // Solution tab the moment they finished typing it.
    const source = [
      "class Solution:",
      "    def reverseList(self, head):",
      "        return self.walk(head)",
      "",
      "    def walk(self, node):",
      "        return node",
    ].join("\n");
    const split = splitSolution(source)!;
    expect(split.skeleton.endsWith("def reverseList(self, head):")).toBe(true);
    expect(split.body).toContain("def walk(self, node):");
  });

  it("declines to split a file with no method at all", () => {
    expect(splitSolution("")).toBeNull();
    expect(splitSolution("# just a comment\nx = 1")).toBeNull();
  });

  it("declines to split when the signature never closes", () => {
    expect(splitSolution("class Solution:\n    def f(self,")).toBeNull();
  });
});

describe("joinSolution", () => {
  const sources = [
    STARTER,
    "class Solution:\n    def f(self):\n        return 1\n",
    "class Solution:\n    def f(self):",
    "class A:\n    def __init__(self):\n        pass\n\nclass Solution:\n    def g(self):\n        return 2",
    "class Solution:\n    def g(self):\n        return self.h()\n\n    def h(self):\n        return 2",
  ];

  it("round-trips every shape it agreed to split", () => {
    // The editor writes `join(skeleton, body)` back to disk on each keystroke,
    // so a lossy split would quietly rewrite the student's file.
    for (const source of sources) {
      const split = splitSolution(source)!;
      expect(split).not.toBeNull();
      expect(joinSolution(split.skeleton, split.body)).toBe(source);
    }
  });
});

describe("skeletonOf", () => {
  it("ignores edits below the signature", () => {
    const worked = `${STARTER}\n        seen = {}\n        return []`;
    expect(skeletonOf(worked)).toBe(skeletonOf(STARTER));
  });

  it("changes when an import is added", () => {
    // This is what lets the wire notice that a delta's anchor moved.
    const withImport = STARTER.replace(
      "from typing import List",
      "from typing import List\nfrom collections import defaultdict",
    );
    expect(skeletonOf(withImport)).not.toBe(skeletonOf(STARTER));
  });

  it("changes when the signature itself is edited", () => {
    const renamed = STARTER.replace("target: int", "target: int, k: int");
    expect(skeletonOf(renamed)).not.toBe(skeletonOf(STARTER));
  });

  it("treats an unsplittable file as all skeleton", () => {
    // Conservative in the safe direction: any edit then forces a full send.
    expect(skeletonOf("x = 1")).toBe("x = 1");
  });
});
