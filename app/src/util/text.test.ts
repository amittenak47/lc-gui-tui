import { describe, expect, it } from "vitest";

import { titleFromSlug } from "./text";

describe("titleFromSlug", () => {
  it("title-cases ordinary LeetCode slugs and keeps roman tails", () => {
    expect(titleFromSlug("two-sum")).toBe("Two Sum");
    expect(titleFromSlug("binary-tree-inorder-traversal-ii")).toBe(
      "Binary Tree Inorder Traversal II",
    );
  });

  it("strips KodCode seed number and style letter", () => {
    expect(titleFromSlug("running-max-45219-c", "45219")).toBe("Running Max");
    expect(titleFromSlug("a-cache-is-a-data-structure-30139-i", "30139")).toBe(
      "A Cache Is A Data Structure",
    );
  });

  it("strips a leading LeetCode number baked into a synthetic name", () => {
    expect(titleFromSlug("101-symmetric-tree-25298-c", "25298")).toBe("Symmetric Tree");
    expect(titleFromSlug("1305-all-elements-in-two-binary-search-trees-5977-c", "5977")).toBe(
      "All Elements In Two Binary Search Trees",
    );
  });

  it("strips leading digit segments like 0-1-knapsack seed names", () => {
    expect(titleFromSlug("0-1-knapsack-problem-19093-c", "19093")).toBe("Knapsack Problem");
  });

  it("keeps digits that are part of a single token (4sum)", () => {
    expect(titleFromSlug("4sum")).toBe("4sum");
  });
});
