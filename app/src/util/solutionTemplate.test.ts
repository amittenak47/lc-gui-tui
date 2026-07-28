import { describe, expect, it } from "vitest";

import {
  extractTopLevelClass,
  helperClassNames,
  isSolutionStub,
  preambleBeforeSolution,
  resolveSolutionSource,
} from "./solutionTemplate";

const FRESH = `from typing import List


class Solution:
    def fourSumCount(self, a: List[int]) -> int:
        pass
`;

const DISK_STALE = `class ListNode:
    def __init__(self, val=0):
        self.val = val


class TreeNode:
    def __init__(self, val=0):
        self.val = val


class Solution:
    def fourSumCount(self, a: List[int]) -> int:
        pass
`;

const DISK_EDITED = `class TreeNode:
    def __init__(self, val=0):
        self.val = val


class Solution:
    def fourSumCount(self, a: List[int]) -> int:
        return 42
`;

describe("resolveSolutionSource", () => {
  it("keeps disk when helpers match the fresh template", () => {
    expect(resolveSolutionSource(FRESH, FRESH)).toContain("fourSumCount");
    expect(helperClassNames(FRESH).has("Solution")).toBe(true);
  });

  it("replaces stale ListNode/TreeNode leftovers with the fresh stub", () => {
    const next = resolveSolutionSource(FRESH, DISK_STALE);
    expect(next).not.toContain("class ListNode");
    expect(next).not.toContain("class TreeNode");
    expect(next).toContain("class Solution");
    expect(next).toContain("fourSumCount");
  });

  it("keeps an edited Solution body while refreshing the preamble", () => {
    const next = resolveSolutionSource(FRESH, DISK_EDITED);
    expect(next).not.toContain("class TreeNode");
    expect(next).toContain("return 42");
    expect(isSolutionStub(extractTopLevelClass(next, "Solution")!)).toBe(false);
  });

  it("extracts preamble before Solution", () => {
    expect(preambleBeforeSolution(FRESH)).toContain("from typing import List");
    expect(preambleBeforeSolution(FRESH)).not.toContain("class Solution");
  });
});
