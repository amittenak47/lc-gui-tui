/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { ProcessBlock, isReasoningEvent, processLine, reasonTitle, reasoningBodyForTurn } from "./ProcessBlock";
import type { CoachProcessEvent } from "../api/types";

describe("reasonTitle", () => {
  it("uses the first clause", () => {
    expect(reasonTitle("SGD is a minibatch estimate. More.")).toBe(
      "SGD is a minibatch estimate",
    );
  });
});

describe("processLine", () => {
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
});

describe("ProcessBlock", () => {
  it("tapping a reason step opens the detail", async () => {
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
    await act(async () => {
      toggle.click();
    });
    const step = host.querySelector(".lc-agent-process-step-btn") as HTMLButtonElement;
    expect(step).toBeTruthy();
    await act(async () => {
      step.click();
    });
    const body = host.querySelector(".lc-agent-process-step-body");
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
});
