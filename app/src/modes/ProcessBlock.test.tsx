/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { ProcessBlock, isReasoningEvent, presentProcessStep, processLine, reasonTitle, reasoningBodyForTurn } from "./ProcessBlock";
import type { CoachProcessEvent } from "../api/types";

describe("reasonTitle", () => {
  it("uses the first clause", () => {
    expect(reasonTitle("SGD is a minibatch estimate. More.")).toBe(
      "SGD is a minibatch estimate",
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
    })).toEqual({ title: "Looking up earlier pages", body: "" });
  });

  it("keeps a reason title and puts only the rest of the thought underneath", () => {
    const shown = presentProcessStep({
      kind: "stage",
      label: "reason",
      detail: "The student is asking whether the algorithm I described. Full walkthrough lives here.",
      ts: 1,
    });
    expect(shown.title).toBe("The student is asking whether the algorithm I described");
    expect(shown.body).toBe("Full walkthrough lives here.");
    expect(shown.body).not.toContain("The student is asking");
  });

  it("keeps the rest of a sentence when the title is truncated", () => {
    const detail = "The student is asking whether the algorithm I described (the DP table with dp[i][j] = min) is the algorithm for the suboptimal cost shown in the document.";
    const shown = presentProcessStep({
      kind: "stage",
      label: "reason",
      detail,
      ts: 1,
    });
    expect(shown.title.endsWith("…")).toBe(true);
    expect(shown.body.length).toBeGreaterThan(20);
    expect(shown.body).not.toContain(shown.title);
    expect(detail.endsWith(shown.body)).toBe(true);
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
    vi.useFakeTimers();
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
    expect(body?.getAttribute("aria-busy")).toBe("true");
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(body?.textContent).toContain("Extra prose");
    expect(body?.closest("[data-active='true']") || body).toBeTruthy();
    root.unmount();
    host.remove();
    vi.useRealTimers();
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
      "The student is asking whether the algorithm I described",
    );
    expect(row?.querySelector(".lc-agent-process-step-body")?.textContent).toContain("Full walkthrough lives here");
    expect(row?.querySelector(".lc-agent-process-step-body")?.textContent).not.toContain(
      "The student is asking whether the algorithm I described.",
    );
    await act(async () => { toggle.click(); });
    expect(row?.querySelector(".lc-agent-process-step-excerpt")?.textContent).toBe(
      "The student is asking whether the algorithm I described",
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

  it("does not render a duplicate body for pipeline stages", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ProcessBlock events={[
        { kind: "stage", label: "ask", detail: "answering from the document", ts: 1 },
        { kind: "stage", label: "prefetch", detail: "looking up earlier pages", ts: 2 },
      ]} running={false} />);
    });
    expect(host.querySelectorAll(".lc-agent-process-step")).toHaveLength(2);
    expect(host.querySelectorAll(".lc-agent-process-step-body")).toHaveLength(0);
    expect(host.textContent).toContain("Answering from the document");
    expect(host.textContent).toContain("Looking up earlier pages");
    expect(host.textContent?.toLowerCase().split("looking up earlier pages").length).toBe(2);
    root.unmount();
    host.remove();
  });
});
