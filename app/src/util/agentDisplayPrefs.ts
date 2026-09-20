import { useEffect, useState } from "react";

export interface AgentDisplayPrefs {
  autoCollapseThinking: boolean;
  collapseThinkingSteps: boolean;
  colorThinkingSteps: boolean;
}
export const DEFAULT_AGENT_DISPLAY_PREFS: AgentDisplayPrefs = {
  autoCollapseThinking: false, collapseThinkingSteps: false, colorThinkingSteps: true,
};
const KEY = "whiteboard.agentDisplay";
export const AGENT_DISPLAY_EVENT = "lc-agent-display";
export function normalizeAgentDisplayPrefs(value: unknown): AgentDisplayPrefs {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(DEFAULT_AGENT_DISPLAY_PREFS).map(([key, fallback]) =>
    [key, typeof raw[key] === "boolean" ? raw[key] : fallback])) as unknown as AgentDisplayPrefs;
}
export function loadAgentDisplayPrefs(): AgentDisplayPrefs {
  try { return normalizeAgentDisplayPrefs(JSON.parse(localStorage.getItem(KEY) ?? "null")); }
  catch { return { ...DEFAULT_AGENT_DISPLAY_PREFS }; }
}
export function saveAgentDisplayPrefs(value: AgentDisplayPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(normalizeAgentDisplayPrefs(value))); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(AGENT_DISPLAY_EVENT));
}
/** One listener per panel, not per transcript row. */
export function useAgentDisplayPrefs(): AgentDisplayPrefs {
  const [prefs, setPrefs] = useState(loadAgentDisplayPrefs);
  useEffect(() => {
    const refresh = () => setPrefs(loadAgentDisplayPrefs());
    window.addEventListener(AGENT_DISPLAY_EVENT, refresh); window.addEventListener("storage", refresh);
    return () => { window.removeEventListener(AGENT_DISPLAY_EVENT, refresh); window.removeEventListener("storage", refresh); };
  }, []);
  return prefs;
}
