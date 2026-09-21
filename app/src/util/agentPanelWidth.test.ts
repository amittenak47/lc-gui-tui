/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PANEL_WIDTH_DEFAULT,
  AGENT_PANEL_WIDTH_MIN,
  applyAgentPanelWidth,
  clampAgentPanelWidth,
  loadAgentPanelWidth,
  maxAgentPanelWidth,
  saveAgentPanelWidth,
} from "./agentPanelWidth";

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
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
  document.documentElement.style.removeProperty("--lc-agent-width");
});

describe("agentPanelWidth", () => {
  it("clamps to a desktop range that leaves room for the document", () => {
    expect(clampAgentPanelWidth(200, 1600)).toBe(AGENT_PANEL_WIDTH_MIN);
    expect(clampAgentPanelWidth(2000, 1600)).toBe(maxAgentPanelWidth(1600));
    expect(maxAgentPanelWidth(1600)).toBeLessThanOrEqual(960);
    expect(maxAgentPanelWidth(850)).toBe(AGENT_PANEL_WIDTH_MIN);
  });

  it("persists a clamped width and writes the CSS variable", () => {
    expect(loadAgentPanelWidth()).toBe(AGENT_PANEL_WIDTH_DEFAULT);
    expect(saveAgentPanelWidth(640)).toBe(640);
    expect(loadAgentPanelWidth()).toBe(640);
    expect(applyAgentPanelWidth(640)).toBe(640);
    expect(document.documentElement.style.getPropertyValue("--lc-agent-width")).toBe("640px");
  });
});
