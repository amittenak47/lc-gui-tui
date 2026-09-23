import { describe, expect, it } from "vitest";
import { formatAgentProse } from "./agentProse";

const thinking = `The student is asking about the three cases of the Master Theorem. This is a standard algorithms question. The context shows they're reading the textbook.

The three cases of the Master Theorem for recurrences of the form T(n) = aT(n/b) + f(n).
1. Case 1: f(n) = O(n^{log_b a - ε}) for some ε > 0. Then T(n) = Θ(n^{log_b a}). The subproblem work dominates (leaves dominate the tree).
2. Case 2: f(n) = Θ(n^{log_b a} log^k n) for some k ≥ 0.
3. Case 3: f(n) = Ω(n^{log_b a + ε}) for some ε > 0, and af(n/b) ≤ cf(n) for some c < 1. Then T(n) = Θ(f(n)).`;

describe("formatAgentProse", () => {
  it("wraps Master Theorem thinking as inline math and splits sentences", () => {
    const out = formatAgentProse(thinking);
    expect(out).toContain("$T(n) = a\\,T(n/b) + f(n)$");
    expect(out).toContain("$f(n) = O(n^{\\log_{b} a - ε})$");
    expect(out).toContain("$ε > 0$");
    expect(out).toContain("$T(n) = \\Theta(n^{\\log_{b} a})$");
    expect(out).toContain("$k \\ge 0$");
    expect(out).toContain("$c < 1$");
    expect(out).toContain("$a\\,f(n/b) \\le c\\,f(n)$");
    expect(out).toContain("\n\nThis is a standard");
    expect(out).toMatch(/\n\n1\. Case 1:/);
    expect(out).not.toMatch(/^\$\$/m);
  });

  it("promotes a standalone equation to display math", () => {
    const out = formatAgentProse("For a recurrence of the form\n\nT(n) = aT(n/b)+f(n), a ≥ 1, b > 1\n\ncompare f(n) against the critical function.");
    expect(out).toContain("$$T(n) = a\\,T(n/b)+f(n), a \\ge 1, b > 1$$");
    expect(out).toContain("$f(n)$");
    expect(out.split("$$").length).toBeGreaterThan(2);
  });

  it("keeps a tight dollar and also accepts spaced dollars and \\(...\\)", () => {
    expect(formatAgentProse("Euler: $e^{i\\pi}+1=0$.")).toContain("$e^{i\\pi}+1=0$");
    expect(formatAgentProse("The cost is $ O(n) $ here.")).toContain("$O(n)$");
    expect(formatAgentProse("Inline \\( \\alpha + \\beta \\) stays inline.")).toContain("$\\alpha + \\beta$");
    expect(formatAgentProse("Display \\[ x = 1 \\] here.")).toContain("$$");
    expect(formatAgentProse("Display \\[ x = 1 \\] here.")).toContain("x = 1");
  });

  it("keeps existing delimiters but demotes mid-sentence display math", () => {
    expect(formatAgentProse("Euler: $e^{i\\pi}+1=0$.")).toContain("$e^{i\\pi}+1=0$");
    expect(formatAgentProse("The sum is $$x+y$$ in the line.")).toContain("$x+y$");
    expect(formatAgentProse("The sum is $$x+y$$ in the line.")).not.toContain("$$x+y$$");
    expect(formatAgentProse("$$\n\\sum_i i\n$$")).toContain("$$");
  });

  it("promotes a lone inline equation line to display", () => {
    expect(formatAgentProse("$T(n) = aT(n/b)+f(n)$")).toBe("$$T(n) = aT(n/b)+f(n)$$");
  });

  it("wraps math inside table cells without turning them into display", () => {
    const table = "| Case | Condition on f(n) |\n| --- | --- |\n| 1 | f(n) = O(n^{log_b a - ε}) |";
    const out = formatAgentProse(table);
    expect(out).toContain("| Case |");
    expect(out).toContain("$f(n) = O(n^{\\log_{b} a - ε})$");
    expect(out).not.toContain("$$");
  });

  it("leaves code fences and inline code alone", () => {
    const src = "Use `$T(n)$` and\n```\nT(n) = 1\n```\nstill T(n) = 1 outside.";
    const out = formatAgentProse(src);
    expect(out).toContain("`$T(n)$`");
    expect(out).toContain("```\nT(n) = 1\n```");
    expect(out).toContain("$T(n) = 1$");
  });

  it("does not wrap ordinary English", () => {
    const out = formatAgentProse("Case 1 is the leaves. The tree picture stays readable.");
    expect(out).not.toContain("$Case");
    expect(out).toContain("\n\nThe tree picture");
  });
});
