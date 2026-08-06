import { describe, expect, it } from "vitest";

import { normalizeStatementForMarkdown } from "./statementMarkdown";

const DESCRIPTION = `Given an m x n binary matrix mat, return the distance of the nearest 0 for each cell.
The distance between two cells sharing a common edge is 1.

Example 1:

Input: mat = [[0,0,0],[0,1,0],[0,0,0]]
Output: [[0,0,0],[0,1,0],[0,0,0]]

Constraints:

m == mat.length
n == mat[i].length
1 <= m, n <= 104
mat[i][j] is either 0 or 1.`;

const MASHED_ALLOCATE_MAILBOXES =
  "A real estate developer is planning to place mailboxes on a street. Given an array houses where houses[i] is the location of the ith house on the street and an integer k, return the minimum number of mailboxes that must be placed so that each house receives mail. Mailboxes must be placed on the street, and a house at position houses[i] can receive mail from a mailbox at position x if |houses[i] - x| <= 1. Example 1: Input: houses = [1,4,8,10,20], k = 3 Output: 5 Explanation: Allocate mailboxes at positions 3, 9, and 20. Constraints: 1 <= houses.length <= 104 1 <= houses[i] <= 10^9 1 <= k <= houses.length All the integers of houses are unique.";

describe("normalizeStatementForMarkdown", () => {
  it("breaks mashed Example/Input/Output/Explanation/Constraints onto their own lines", () => {
    const out = normalizeStatementForMarkdown(MASHED_ALLOCATE_MAILBOXES);

    expect(out).toMatch(/\n\nExample 1:\s*\n\n/);
    expect(out).toMatch(/\n\nInput:\s*\n\nhouses = \[1,4,8,10,20\], k = 3/);
    expect(out).toMatch(/\n\nOutput:\s*\n\n5\b/);
    expect(out).toMatch(/\n\nExplanation:\s*\n\nAllocate mailboxes/);
    expect(out).toMatch(/\n\nConstraints:\s*\n\n/);
    expect(out).toContain("houses.length <= 10<sup>4</sup>");
    expect(out).toMatch(/10<sup>4<\/sup>\n1 <= houses\[i\]/);
    expect(out).toMatch(/10<sup>9<\/sup>\n1 <= k <= houses\.length/);
    expect(out).toMatch(/\n\nAll the integers of houses are unique\./);
  });

  it("stays sensible on an already well-formed description (idempotent-ish)", () => {
    const once = normalizeStatementForMarkdown(DESCRIPTION);
    const twice = normalizeStatementForMarkdown(once);

    expect(once).toContain("Example 1:");
    expect(once).toMatch(/Input:\s*\n\nmat =/);
    expect(once).toContain("Constraints:");
    expect(once).toContain("10<sup>4</sup>");
    expect(twice).toBe(once);
  });

  it("converts 104 to 10<sup>4</sup> in constraints", () => {
    const out = normalizeStatementForMarkdown("Constraints:\n1 <= m, n <= 104");
    expect(out).toContain("10<sup>4</sup>");
    expect(out).not.toMatch(/<= 104\b/);
  });

  it("does not treat 100 as an exponent", () => {
    const out = normalizeStatementForMarkdown("Constraints:\n1 <= n <= 100");
    expect(out).toContain("<= 100");
    expect(out).not.toContain("<sup>");
  });

  it("converts 10^9 style exponents", () => {
    const out = normalizeStatementForMarkdown("1 <= houses[i] <= 10^9");
    expect(out).toContain("10<sup>9</sup>");
  });

  it("normalizes HTML line breaks and keeps sup tags", () => {
    const out = normalizeStatementForMarkdown(
      "<p>Given nums.</p><br>Example 1:<br>Input: x = 1",
    );
    expect(out).toContain("Given nums.");
    expect(out).toMatch(/\n\nExample 1:/);
    expect(out).toMatch(/\n\nInput:\s*\n\nx = 1/);
  });
});
