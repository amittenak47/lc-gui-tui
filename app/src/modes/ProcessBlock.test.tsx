/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { ProcessBlock, isReasoningEvent, presentProcessStep, processLine, reasonTitle, reasoningBodyForTurn } from "./ProcessBlock";
import type { CoachProcessEvent } from "../api/types";

describe("reasonTitle", () => {
  it("summarizes a long thought instead of taking the first clause", () => {
    expect(reasonTitle("The student is asking whether the algorithm I described. More.")).toBe(
      "What they're asking",
    );
  });

  it("keeps a short complete thought as the chip", () => {
    expect(reasonTitle("SGD is a minibatch estimate.")).toBe("SGD is a minibatch estimate");
  });

  it("uses a short first sentence as the chip and keeps the whole thought underneath", () => {
    const detail = "First inspect every cell in the array. Then compare the pointer.";
    expect(reasonTitle(detail)).toBe("First inspect every cell in the array");
    expect(presentProcessStep({ kind: "stage", label: "reason", detail, ts: 1 }).body).toBe(detail);
  });

  it("uses a heading line as the summary", () => {
    expect(reasonTitle("The DP recurrence\ndp[i][j] = min(delete, insert, substitute)")).toBe(
      "The recurrence",
    );
  });
});

describe("presentProcessStep", () => {
  it("promotes a generic Thinking stage's detail and hides the lowercase duplicate", () => {
    expect(presentProcessStep({
      kind: "stage",
      label: "ask",
      detail: "answering from the document",
      ts: 1,
    })).toEqual({ title: "Answering from the document", body: "" });
  });

  it("keeps the prefetch label and does not repeat it underneath", () => {
    expect(presentProcessStep({
      kind: "stage",
      label: "prefetch",
      detail: "looking up earlier pages",
      ts: 1,
    })).toEqual({ title: "Searching this document", body: "" });
  });

  it("puts the entire thought under a summary chip", () => {
    const detail = "The student is asking whether the algorithm I described. Full walkthrough lives here.";
    const shown = presentProcessStep({
      kind: "stage",
      label: "reason",
      detail,
      ts: 1,
    });
    expect(shown.title).toBe("What they're asking");
    expect(shown.body).toBe(detail);
  });

  it("does not split a long first sentence across title and body", () => {
    const detail = "The student is asking whether the algorithm I described (the DP table with dp[i][j] = min) is the algorithm for the suboptimal cost shown in the document.";
    const shown = presentProcessStep({
      kind: "stage",
      label: "reason",
      detail,
      ts: 1,
    });
    expect(shown.title.endsWith("…")).toBe(false);
    expect(shown.title).toBe("What they're asking");
    expect(shown.body).toBe(detail);
  });
});

describe("processLine", () => {
  it("shows genuine stream updates immediately in the same row", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const event: CoachProcessEvent = { kind: "stage", label: "reason", detail: "First", updateId: "reason-1-0", ts: 1 };
    await act(async () => root.render(<ProcessBlock events={[event]} running />));
    const row = host.querySelector(".lc-agent-process-step");
    expect(row?.textContent).toContain("First");
    await act(async () => root.render(<ProcessBlock events={[{ ...event, detail: "First complete step", ts: 2 }]} running />));
    expect(host.querySelector(".lc-agent-process-step")).toBe(row);
    expect(row?.textContent).toContain("First complete step");
    await act(async () => root.unmount());
    host.remove();
  });

  it("capitalizes tool status lines and calls them annotations", () => {
    const shown = presentProcessStep({
      kind: "tool",
      label: "list_document_marks",
      status: "accepted",
      detail: "no marks packed into this Ask",
      ts: 1,
    });
    expect(shown.title).toBe("Listing annotations");
    expect(shown.body).toBe("No annotations packed into this Ask");
    expect(presentProcessStep({
      kind: "tool",
      label: "get_current_page",
      status: "proposed",
      detail: "reading this page",
      ts: 1,
    }).body).toBe("Reading this page");
  });

  it("names document tools instead of 'drew'", () => {
    expect(
      processLine({
        kind: "tool",
        label: "query_document_vectors",
        status: "accepted",
        ts: 1,
      }),
    ).toBe("searching the book");
  });

  it("titles a reason step from detail", () => {
    expect(
      processLine({
        kind: "stage",
        label: "reason",
        detail: "The highlight names SGD as a minibatch gradient.",
        ts: 1,
      }),
    ).toBe("The highlight names SGD as a minibatch gradient");
  });

  it("uses the ask detail instead of Thinking…", () => {
    expect(
      processLine({
        kind: "stage",
        label: "ask",
        detail: "answering from the document",
        ts: 1,
      }),
    ).toBe("Answering from the document");
  });
});

describe("ProcessBlock", () => {
  it("reveals full live step details automatically without tapping titles", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const events: CoachProcessEvent[] = [
      {
        kind: "stage",
        label: "reason",
        detail: "The highlight names SGD as a minibatch gradient. Extra prose.",
        ts: 1,
      },
    ];
    await act(async () => {
      root.render(<ProcessBlock events={events} running={true} />);
    });
    const toggle = host.querySelector(".lc-agent-process-toggle") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".lc-agent-process-step-btn")).toBeNull();
    const body = host.querySelector(".lc-agent-process-step-body");
    expect(body?.getAttribute("aria-busy")).toBe("false");
    expect(body?.textContent).toContain("Extra prose");
    expect(body?.closest("[data-active='true']") || body).toBeTruthy();
    root.unmount();
    host.remove();
  });

  it("keeps reason stages in Thinking and leaves the CoT blob for Reasoning", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const events: CoachProcessEvent[] = [
      {
        kind: "stage",
        label: "reason",
        detail: "Compare the two rows first.",
        ts: 1,
      },
      {
        kind: "reasoning",
        label: "reasoning",
        detail: "Full chain of thought that must not become a Thinking step.",
        ts: 2,
      },
    ];
    expect(isReasoningEvent(events[0]!)).toBe(false);
    expect(isReasoningEvent(events[1]!)).toBe(true);
    expect(reasoningBodyForTurn(undefined, events)).toContain("Full chain");
    await act(async () => {
      root.render(<ProcessBlock events={events} running={false} />);
    });
    const toggle = host.querySelector(".lc-agent-process-toggle") as HTMLButtonElement;
    expect(toggle.textContent).toContain("Thinking");
    expect(toggle.textContent).toContain("1 step");
    root.unmount();
    host.remove();
  });

  it("keeps the bullet title when expanded and uses a color dot instead of a chevron", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const events: CoachProcessEvent[] = [
      {
        kind: "stage",
        label: "reason",
        detail: "The student is asking whether the algorithm I described. Full walkthrough lives here.",
        ts: 1,
      },
    ];
    await act(async () => {
      root.render(<ProcessBlock events={events} running={false} />);
    });
    const row = host.querySelector(".lc-agent-process-step");
    const toggle = host.querySelector(".lc-agent-process-step-toggle") as HTMLButtonElement;
    expect(toggle.textContent).toBe("");
    expect(toggle.querySelector(".lc-agent-process-step-dot")).toBeTruthy();
    expect(row?.querySelector(".lc-agent-process-step-excerpt")?.textContent).toBe(
      "What they're asking",
    );
    expect(row?.querySelector(".lc-agent-process-step-body")?.textContent).toContain(
      "The student is asking whether the algorithm I described.",
    );
    expect(row?.querySelector(".lc-agent-process-step-body")?.textContent).toContain(
      "Full walkthrough lives here.",
    );
    await act(async () => { toggle.click(); });
    expect(row?.querySelector(".lc-agent-process-step-excerpt")?.textContent).toBe(
      "What they're asking",
    );
    expect(row?.querySelector(".lc-agent-process-step-body")).toBeNull();
    root.unmount();
    host.remove();
  });

  it("folds numbered list items back into the thought that introduced them", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const events: CoachProcessEvent[] = [
      { kind: "stage", label: "reason", ts: 1, detail: "So the document describes:" },
      { kind: "stage", label: "reason", ts: 2, detail: "1. The concept of alignment" },
      { kind: "stage", label: "reason", ts: 3, detail: "2. The cost of an alignment" },
    ];
    await act(async () => {
      root.render(<ProcessBlock events={events} running={false} />);
    });
    expect(host.querySelectorAll(".lc-agent-process-step")).toHaveLength(1);
    expect(host.querySelector(".lc-agent-process-toggle")?.textContent).toContain("1 step");
    expect(host.textContent).toContain("The concept of alignment");
    expect(host.textContent).toContain("The cost of an alignment");
    root.unmount();
    host.remove();
  });

  it("keeps pipeline stages in the header, not as thought chips", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const events: CoachProcessEvent[] = [
      { kind: "stage", label: "ask", detail: "answering from the document", ts: 1 },
      { kind: "stage", label: "prefetch", detail: "Pages 4 and 5 on screen. Also reading page 3.", ts: 2 },
    ];
    await act(async () => {
      root.render(<ProcessBlock events={events} running={false} />);
    });
    expect(host.querySelector(".lc-agent-process")).toBeNull();
    await act(async () => {
      root.render(<ProcessBlock events={events} running />);
    });
    expect(host.querySelectorAll(".lc-agent-process-step")).toHaveLength(0);
    expect(host.querySelector(".lc-agent-process-label")?.textContent).toBe("Pages 4 and 5 on screen. Also reading page 3.");
    root.unmount();
    host.remove();
  });

  it("shows a prefix and stats for each passage under the thinking header", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const detail = [
      "Pages 4 and 5 on screen. Also reading pages 1 and 3.",
      "p3 · above · 40 chars · the paragraph just above the viewport",
      "p1 · 2 shared · 32 chars · unique zebra theorem lives here",
    ].join("\n");
    const events: CoachProcessEvent[] = [
      { kind: "stage", label: "prefetch", detail, ts: 1 },
      { kind: "stage", label: "reason", detail: "The student is asking about the theorem.", ts: 2 },
    ];
    await act(async () => {
      root.render(<ProcessBlock events={events} running />);
    });
    expect(host.querySelector(".lc-agent-process-label")?.textContent).toBe("Thinking…");
    const lines = [...host.querySelectorAll(".lc-agent-passage")].map((node) => node.textContent);
    expect(lines).toEqual([
      "p3 · above · 40 chars · the paragraph just above the viewport",
      "p1 · 2 shared · 32 chars · unique zebra theorem lives here",
    ]);
    expect(host.querySelectorAll(".lc-agent-process-step")).toHaveLength(1);
    await act(async () => {
      root.render(<ProcessBlock events={events} running={false} />);
    });
    expect(host.querySelector(".lc-agent-process-label")?.textContent).toBe("Thinking · 1 step · 2 passages");
    root.unmount();
    host.remove();
  });

  it("typesets thinking math and markdown lists", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const detail = "The student is asking about Euler: $e^{i\\pi} + 1 = 0$.\n\n1. Leaves dominate\n2. Balanced";
    await act(async () => {
      root.render(<ProcessBlock events={[{ kind: "stage", label: "reason", detail, ts: 1, updateId: "r-math" }]} running={false} />);
    });
    const body = host.querySelector(".lc-agent-process-step-body");
    expect(host.querySelector(".lc-agent-process-step-excerpt")?.textContent).toBe("What they're asking");
    expect(body?.querySelector(".katex")).not.toBeNull();
    expect(body?.querySelector("ol, ul")).not.toBeNull();
    expect(body?.textContent).toContain("Leaves dominate");
    root.unmount();
    host.remove();
  });
});
