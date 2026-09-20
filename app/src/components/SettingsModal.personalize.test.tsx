/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsModal } from "./SettingsModal";
import { DEFAULT_COACH_FLAGS, type LcConfig } from "../api/types";
import type { LcClient } from "../api/client";
import { loadAgentDisplayPrefs } from "../util/agentDisplayPrefs";
import { loadUiHandedness } from "../util/uiHandedness";
import { loadInkHandedness } from "../util/inkHandedness";

vi.mock("../util/devicePrefs", async importOriginal => ({
  ...await importOriginal<typeof import("../util/devicePrefs")>(),
  ensureDevicePrefs: vi.fn(async () => null), saveThisDevicePrefs: vi.fn(async () => null),
}));
let root: ReturnType<typeof createRoot>; let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches:true,addEventListener() {},removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); localStorage.clear(); });
function client() {
  const endpoint = {base_url:"http://fixture",model:"test",vision:false,vision_model:""};
  const config = {local:endpoint,ollama:endpoint,openai:endpoint,groq:endpoint,coach:{...DEFAULT_COACH_FLAGS},
    modes:{ambient:"local",review:"local",bridge:"local",viz:"local",planner:"local"},dataset_dirs:{},workspace_dir:"test",serve_port:7878,default_provider:"local"} as LcConfig;
  return {getConfig:vi.fn(async()=>config),putConfig:vi.fn(async()=>config),lanBaseUrl:vi.fn(async()=>"http://fixture"),
    llmStatus:vi.fn(async()=>({running:false})),bootNotice:vi.fn(async()=>null),datasets:vi.fn(async()=>[]),listDevices:vi.fn(async()=>[])} as unknown as LcClient;
}
const button = (text:string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===text)!;
const switchButton = (label:string) => [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(b=>b.querySelector('strong')?.textContent===label)!;
async function show(api:LcClient,onClose=()=>{}) {
  await act(async()=>root.render(<SettingsModal open client={api} onClose={onClose}/>));
  await act(async()=>button("UI").click());
}
it("keeps UI drafts local until Save and Cancel does not persist", async()=>{
  const api=client(),close=vi.fn(); await show(api,close);
  await act(async()=>{ button("Left hand").click(); switchButton("Auto-collapse Thinking when the answer arrives").click(); });
  expect(loadUiHandedness()).toBe("right"); expect(loadAgentDisplayPrefs().autoCollapseThinking).toBe(false);
  await act(async()=>button("Cancel").click()); expect(close).toHaveBeenCalledOnce();
  expect(loadUiHandedness()).toBe("right"); expect(api.putConfig).not.toHaveBeenCalled();
});
it("saves UI hand and Thinking preferences without changing ink or making a model config write", async()=>{
  const api=client(); await show(api);
  await act(async()=>{ button("Left hand").click(); switchButton("Start Thinking steps collapsed").click(); });
  await act(async()=>button("Save").click());
  expect(loadUiHandedness()).toBe("left"); expect(loadInkHandedness()).toBe("right");
  expect(loadAgentDisplayPrefs()).toMatchObject({collapseThinkingSteps:true,autoCollapseThinking:false});
  expect(api.putConfig).not.toHaveBeenCalled();
});
it("preserves shared coach flags when moving controls into UI", async()=>{
  const api=client(); await show(api);
  await act(async()=>switchButton("Answer over the live connection").click());
  await act(async()=>button("Save").click());
  expect(api.putConfig).toHaveBeenCalledWith(expect.objectContaining({coach:expect.objectContaining({ws_runs:false,process_events_ui:true})}), {timeoutMs:30000});
});
