/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProcessBlock } from "./ProcessBlock";
import { newThinkingDisclosure } from "./thinkingDisplay";
import { DEFAULT_AGENT_DISPLAY_PREFS } from "../util/agentDisplayPrefs";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const events = [0,1,2].map(i => ({kind:"stage" as const,label:"reason",detail:`Thought ${i}. Full text.`,updateId:`r-${i}`,ts:i}));
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".lc-agent-process-step-toggle"));
it("keeps several steps open and preserves individual choices through completion and remount", () => {
  const state = newThinkingDisclosure();
  const render = (running: boolean) => act(() => root.render(<ProcessBlock events={events} running={running} disclosure={state} />));
  render(true);
  expect(buttons().map(b => b.getAttribute("aria-expanded"))).toEqual(["true","true","true"]);
  act(() => buttons()[1]!.click()); render(false);
  expect(buttons().map(b => b.getAttribute("aria-expanded"))).toEqual(["true","false","true"]);
  act(() => root.render(null)); render(false);
  expect(buttons().map(b => b.getAttribute("aria-expanded"))).toEqual(["true","false","true"]);
  act(() => buttons()[1]!.click());
  expect(host.textContent).toContain("Thought 1");
  expect(host.textContent).toContain("Full text.");
  expect(host.querySelectorAll(".lc-agent-process-step")[1]?.querySelector(".lc-agent-process-step-body")?.textContent).toBe(
    "Thought 1. Full text.",
  );
});
it.each([false, true])("step defaults are independent with section auto-collapse=%s", autoCollapseThinking => {
  const state = newThinkingDisclosure();
  act(() => root.render(<ProcessBlock events={events} running disclosure={state}
    displayPrefs={{...DEFAULT_AGENT_DISPLAY_PREFS,autoCollapseThinking,collapseThinkingSteps:true}} />));
  expect(buttons().map(b => b.getAttribute("aria-expanded"))).toEqual(["false","false","false"]);
  act(() => { buttons()[0]!.click(); buttons()[2]!.click(); });
  expect(buttons().map(b => b.getAttribute("aria-expanded"))).toEqual(["true","false","true"]);
});
