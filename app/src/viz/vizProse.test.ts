import { describe, expect, it } from "vitest";
import { drawingHeading, formatVizProse, isMachineTitle } from "./vizProse";
import type { VizProgram } from "./schema";

describe("formatVizProse", () => {
  it("typesets a Master Theorem dump into readable markdown", () => {
    const out = formatVizProse(
      "Each level: a^k subproblems of size n/b^k. Work per level = a^k · (n/b^k)^d. Ratio r=3/2>1, so work grows each level → Case 2. Total ≈ 8+12+18+27 = 65 ≈ n^(log_b 3) ≈ 65.8",
    );
    expect(out).toContain("$a^{k}$");
    expect(out).toContain("$n/b^{k}$");
    expect(out).toContain("$(n/b^{k})^{d}$");
    expect(out).toContain("$r=3/2>1$");
    expect(out).toContain("$n^{\\log_{b} 3}$");
    expect(out).toContain("$8+12+18+27 = 65$");
    expect(out.split("\n\n").length).toBeGreaterThan(2);
  });

  it("leaves already-delimited math alone", () => {
    expect(formatVizProse("Work is $a^{k}$ per level.")).toBe("Work is $a^{k}$ per level.");
  });
});

describe("drawingHeading", () => {
  it("prefers a human label over a kebab id", () => {
    expect(isMachineTitle("master-tree")).toBe(true);
    const program = {
      viz: "tree",
      id: "master-tree",
      title: "master-tree",
      frames: [{ label: "Recursion tree: a=3, b=2, d=1, n=8", cells: [], pointers: {}, highlight: [], entries: [], note: "" }],
    } as VizProgram;
    expect(drawingHeading(program)).toBe("Recursion tree: a=3, b=2, d=1, n=8");
  });
});
