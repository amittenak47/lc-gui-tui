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

describe("splitSolution (editor tabs)", () => {
  it("cuts before class Solution — Imports vs the full Solution class", () => {
    const split = splitSolution(STARTER)!;
    expect(split.skeleton).toContain("from typing import List");
    expect(split.skeleton).not.toContain("class Solution");
    expect(split.body.startsWith("class Solution:")).toBe(true);
    expect(split.body).toContain("def twoSum");
  });

  it("puts ListNode / TreeNode helpers in Imports, not Solution", () => {
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
    expect(split.skeleton).not.toContain("class Solution");
    expect(split.body.startsWith("class Solution:")).toBe(true);
    expect(split.body).toContain("def reverseList");
    expect(split.body).toContain("return prev");
  });

  it("keeps student helper methods inside Solution", () => {
    const source = [
      "from typing import Optional",
      "",
      "class Solution:",
      "    def reverseList(self, head):",
      "        return self.walk(head)",
      "",
      "    def walk(self, node):",
      "        return node",
    ].join("\n");
    const split = splitSolution(source)!;
    expect(split.skeleton).toBe("from typing import Optional\n");
    expect(split.body).toContain("def reverseList");
    expect(split.body).toContain("def walk");
  });

  it("declines to split a file with no Solution class", () => {
    expect(splitSolution("")).toBeNull();
    expect(splitSolution("# just a comment\nx = 1")).toBeNull();
    expect(splitSolution("def twoSum(nums):\n    return []")).toBeNull();
  });
});

describe("joinSolution", () => {
  const sources = [
    STARTER,
    "class Solution:\n    def f(self):\n        return 1\n",
    "class Solution:\n    def f(self):",
    "class A:\n    def __init__(self):\n        pass\n\nclass Solution:\n    def g(self):\n        return 2",
    "from typing import List\n\nclass Solution:\n    def g(self):\n        return self.h()\n\n    def h(self):\n        return 2",
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

describe("skeletonOf (wire anchor)", () => {
  it("cuts under the entry-point signature, not before the class", () => {
    // Tabs put the signature in Solution; the wire anchor still includes it
    // so a renamed parameter forces a full code send.
    const anchor = skeletonOf(STARTER);
    expect(anchor).toContain("from typing import List");
    expect(anchor).toContain("class Solution:");
    expect(anchor).toContain("def twoSum");
    expect(anchor.endsWith("-> List[int]:")).toBe(true);
    expect(anchor).not.toContain("seen");
  });

  it("keeps a wrapped signature whole", () => {
    const source = [
      "class Solution:",
      "    def merge(",
      "        self,",
      "        intervals: List[List[int]],",
      "    ) -> List[List[int]]:",
      "        return []",
    ].join("\n");
    expect(skeletonOf(source).endsWith(") -> List[List[int]]:")).toBe(true);
  });

  it("is not fooled by a colon inside the signature's own text", () => {
    const source = [
      "class Solution:",
      "    def f(self, sep: str = ':') -> str:  # split on ':'",
      "        return sep",
    ].join("\n");
    expect(skeletonOf(source).endsWith("-> str:  # split on ':'")).toBe(true);
  });

  it("anchors at the entry point, not at a helper class above it", () => {
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
    const anchor = skeletonOf(source);
    expect(anchor).toContain("class ListNode:");
    expect(anchor.endsWith("def reverseList(self, head):")).toBe(true);
    expect(anchor).not.toContain("prev = None");
  });

  it("anchors at the entry point, not at a helper the student added below", () => {
    const source = [
      "class Solution:",
      "    def reverseList(self, head):",
      "        return self.walk(head)",
      "",
      "    def walk(self, node):",
      "        return node",
    ].join("\n");
    expect(skeletonOf(source).endsWith("def reverseList(self, head):")).toBe(true);
    expect(skeletonOf(source)).not.toContain("def walk");
  });

  it("ignores edits below the signature", () => {
    const worked = `${STARTER}\n        seen = {}\n        return []`;
    expect(skeletonOf(worked)).toBe(skeletonOf(STARTER));
  });

  it("changes when an import is added", () => {
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
    expect(skeletonOf("x = 1")).toBe("x = 1");
  });
});
