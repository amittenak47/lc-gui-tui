import { describe, expect, it } from "vitest";
import { chunkReasonEvents, splitReasonSteps } from "./reasonChunks";
import type { CoachProcessEvent } from "../api/types";

const COT = `\
The student is asking whether the algorithm I described (the DP table with dp[i][j] = min) is the algorithm for the suboptimal edit distance alignment cost shown in the document.
Let me re-read the document context. The document says:
"In general, there are so many possible alignments between two strings that it would be terribly inefficient to search through all of them for the best one."
So the document describes:
1. The concept of alignment (writing strings one above the other with gaps)
2. The cost of an alignment (number of columns where letters differ)
3. Edit distance = cost of the best possible alignment
4. The observation that brute-forcing all alignments is infeasible
The document does not actually show a suboptimal algorithm per se.
Wait, let me re-read. The student says they are NOT referring to the correct implementation.
So the student seems to be asking: is the DP table algorithm the one that computes the suboptimal cost shown in the document?
Actually, I think the student is confused. The document doesn't show a suboptimal algorithm.
So the answer is: No, the DP table is the efficient algorithm. The suboptimal approach the document alludes to is simply trying every possible alignment.`;

describe("splitReasonSteps", () => {
  it("keeps numbered document points inside the thought that introduced them", () => {
    const blob = `\
The document describes:
1. The concept of alignment (writing strings one above the other with gaps)
2. The cost of an alignment (number of columns where letters differ)
3. Edit distance = cost of the best possible alignment
4. The observation that brute-forcing all alignments is infeasible
The document does not actually show a suboptimal algorithm.`;
    const steps = splitReasonSteps(blob);
    expect(steps.some((step) => /^1\.\s/.test(step))).toBe(false);
    expect(steps.some((step) => step.includes("1. The concept of alignment"))).toBe(true);
    expect(steps.some((step) => step.includes("4. The observation"))).toBe(true);
  });

  it("breaks a long CoT into several thoughts, not one wall of text", () => {
    const steps = splitReasonSteps(COT);
    expect(steps.length).toBeGreaterThan(2);
    expect(steps.length).toBeLessThanOrEqual(12);
    expect(steps[0]).toMatch(/The student is asking/i);
    expect(steps.some((step) => step.includes("1. The concept of alignment"))).toBe(true);
    expect(steps.some((step) => /Wait, let me re-read/i.test(step))).toBe(true);
  });

  it("still splits markdown headings and blank paragraphs", () => {
    expect(splitReasonSteps("# Check the board\nLook at the ink.\n\n# Name the claim\nSGD is the method.")).toHaveLength(2);
    expect(splitReasonSteps("alpha is first.\n\nbeta is second.\n\ngamma is third.")).toHaveLength(3);
  });
});

describe("chunkReasonEvents", () => {
  it("does not re-chunk a live streamed reason row", () => {
    const shown = chunkReasonEvents([
      { kind: "stage", label: "reason", detail: COT, ts: 3, updateId: "reason-1-0" },
    ]);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.updateId).toBe("reason-1-0");
    expect(shown[0]?.detail).toBe(COT);
  });

  it("leaves pipeline stages alone and splits a stored reason blob", () => {
    const events: CoachProcessEvent[] = [
      { kind: "stage", label: "ask", detail: "answering from the document", ts: 1 },
      { kind: "stage", label: "prefetch", detail: "looking up earlier pages", ts: 2 },
      { kind: "stage", label: "reason", detail: COT, ts: 3 },
    ];
    const shown = chunkReasonEvents(events);
    expect(shown[0]?.label).toBe("ask");
    expect(shown[1]?.label).toBe("prefetch");
    expect(shown.length).toBeGreaterThan(4);
    expect(shown.slice(2).every((event) => event.label === "reason" && !event.updateId)).toBe(true);
  });
});
