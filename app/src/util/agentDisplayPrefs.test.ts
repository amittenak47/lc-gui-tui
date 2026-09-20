/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_DISPLAY_PREFS, AGENT_DISPLAY_EVENT, loadAgentDisplayPrefs, normalizeAgentDisplayPrefs, saveAgentDisplayPrefs } from "./agentDisplayPrefs";
import { applyDevicePrefsBlob, collectDevicePrefsBlob } from "./devicePrefs";
afterEach(() => localStorage.clear());
it("keeps full Thinking open for new and malformed saved prefs", () => {
  expect(loadAgentDisplayPrefs()).toEqual(DEFAULT_AGENT_DISPLAY_PREFS);
  expect(normalizeAgentDisplayPrefs({autoCollapseThinking:"yes"})).toEqual(DEFAULT_AGENT_DISPLAY_PREFS);
});
it("saves and notifies only on an explicit save", () => {
  const listener = vi.fn(); window.addEventListener(AGENT_DISPLAY_EVENT, listener);
  const draft = {...loadAgentDisplayPrefs(),autoCollapseThinking:true};
  expect(loadAgentDisplayPrefs().autoCollapseThinking).toBe(false); expect(listener).not.toHaveBeenCalled();
  saveAgentDisplayPrefs(draft); expect(loadAgentDisplayPrefs()).toEqual(draft); expect(listener).toHaveBeenCalledOnce();
  window.removeEventListener(AGENT_DISPLAY_EVENT, listener);
});
it("round trips appearance and UI hand without changing ink hand", () => {
  localStorage.setItem("whiteboard.inkHandedness", "left");
  applyDevicePrefsBlob({uiHandedness:"right",agentDisplay:{autoCollapseThinking:true,colorThinkingSteps:false}});
  expect(collectDevicePrefsBlob()).toMatchObject({handedness:"left",uiHandedness:"right",agentDisplay:{autoCollapseThinking:true,collapseThinkingSteps:false,colorThinkingSteps:false}});
});
