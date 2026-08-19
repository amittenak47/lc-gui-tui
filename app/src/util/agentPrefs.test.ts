import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cycleAgentReasoning,
  loadAgentReasoningLevel,
  reasoningAskFields,
  saveAgentReasoningLevel,
} from "./agentPrefs";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cycleAgentReasoning", () => {
  it("walks off → low → medium → high → off", () => {
    expect(cycleAgentReasoning("off")).toBe("low");
    expect(cycleAgentReasoning("low")).toBe("medium");
    expect(cycleAgentReasoning("medium")).toBe("high");
    expect(cycleAgentReasoning("high")).toBe("off");
  });
});

describe("loadAgentReasoningLevel", () => {
  it("defaults to medium", () => {
    expect(loadAgentReasoningLevel()).toBe("medium");
  });

  it("reads the v1 off flag", () => {
    localStorage.setItem("whiteboard.agent.reasoning.v1", "0");
    expect(loadAgentReasoningLevel()).toBe("off");
  });

  it("reads a stored level", () => {
    saveAgentReasoningLevel("high");
    expect(loadAgentReasoningLevel()).toBe("high");
  });
});

describe("reasoningAskFields", () => {
  it("omits keys when off", () => {
    expect(reasoningAskFields("off")).toEqual({});
  });

  it("sends effort when on", () => {
    expect(reasoningAskFields("low")).toEqual({
      reasoning: true,
      reasoning_effort: "low",
    });
  });
});
