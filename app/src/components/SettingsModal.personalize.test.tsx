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
import { loadPalettePrefs } from "../util/palettePref";

vi.mock("../util/devicePrefs", async importOriginal => ({
  ...await importOriginal<typeof import("../util/devicePrefs")>(),
  ensureDevicePrefs: vi.fn(async () => null), saveThisDevicePrefs: vi.fn(async () => null),
}));
let root: ReturnType<typeof createRoot>; let host: HTMLDivElement;
beforeEach(() => {
  const values = new Map<string,string>();
  vi.stubGlobal("localStorage", {
    getItem: (key:string) => values.get(key) ?? null,
    setItem: (key:string,value:string) => { values.set(key,String(value)); },
    removeItem: (key:string) => { values.delete(key); },
    clear: () => values.clear(), key: (index:number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  });
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches:true,addEventListener() {},removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); });
function client() {
  const endpoint = {base_url:"http://fixture",model:"test",vision:false,vision_model:""};
  const config = {local:endpoint,ollama:endpoint,openai:endpoint,groq:endpoint,coach:{...DEFAULT_COACH_FLAGS},
    modes:{ambient:"local",review:"local",bridge:"local",viz:"local",planner:"local"},dataset_dirs:{},workspace_dir:"test",serve_port:7878,default_provider:"local"} as LcConfig;
  return {getConfig:vi.fn(async()=>config),putConfig:vi.fn(async()=>config),lanBaseUrl:vi.fn(async()=>"http://fixture"),
    llmStatus:vi.fn(async()=>({running:false})),bootNotice:vi.fn(async()=>null),datasets:vi.fn(async()=>[]),listDevices:vi.fn(async()=>[])} as unknown as LcClient;
}
const button = (text:string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===text || b.querySelector(".lc-settings-fold-title")?.textContent===text)!;
const switchButton = (label:string) => [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(b=>b.querySelector('strong')?.textContent===label)!;
const count = () => host.querySelector('.lc-settings-change-count')?.textContent;
async function search(value:string) {
  await act(async()=>{
    const input=host.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
}
async function show(api:LcClient,onClose=()=>{}) {
  await act(async()=>root.render(<SettingsModal open client={api} onClose={onClose}/>));
  await act(async()=>button("UI").click());
}
it("keeps UI drafts local until Save and Cancel does not persist", async()=>{
  const api=client(),close=vi.fn(); await show(api,close);
  await act(async()=>{ button("Left hand").click(); switchButton("Collapse when the answer arrives").click(); });
  expect(loadUiHandedness()).toBe("right"); expect(loadAgentDisplayPrefs().autoCollapseThinking).toBe(false);
  await act(async()=>button("Cancel").click()); expect(close).toHaveBeenCalledOnce();
  expect(loadUiHandedness()).toBe("right"); expect(api.putConfig).not.toHaveBeenCalled();
});
it("saves UI hand and Thinking preferences without changing ink or making a model config write", async()=>{
  const api=client(); await show(api);
  await act(async()=>{ button("Left hand").click(); switchButton("Start steps collapsed").click(); });
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
it("counts individual changes and removes reverted drafts across groups", async()=>{
  await show(client()); expect(count()).toBe('No changes');
  await act(async()=>{button('Left hand').click();switchButton('Start steps collapsed').click();});
  expect(count()).toBe('2 changes');
  await act(async()=>button('Right hand').click()); expect(count()).toBe('1 change');
  await act(async()=>button('Scroll').click()); expect(count()).toBe('1 change');
  await act(async()=>button('UI').click());
  expect(switchButton('Start steps collapsed').getAttribute('aria-checked')).toBe('true');
  await act(async()=>switchButton('Start steps collapsed').click()); expect(count()).toBe('No changes');
  expect(button('Save').disabled).toBe(true);
});
it("searches existing controls across tabs without losing edits", async()=>{
  await show(client()); await act(async()=>button('Left hand').click());
  await search('Default provider');
  expect([...host.querySelectorAll('.lc-settings-fold-title')].map(n=>n.textContent)).toEqual(['LLM']);
  await act(async()=>host.querySelector<HTMLButtonElement>('.lc-settings-fold-summary')!.click());
  expect(host.querySelector('select')).not.toBeNull(); expect(count()).toBe('1 change');
  await search('doesnotexist'); expect(host.querySelector('.lc-settings-fold')).toBeNull();
  await search('Debug log'); expect(host.querySelector('.lc-settings-fold-title')?.textContent).toBe('Diagnostics');
  await search(''); await act(async()=>button('UI').click());
  expect(button('Left hand').getAttribute('aria-checked')).toBe('true');
});
it("counts only unsaved settings after partial save failure and retries", async()=>{
  const api=client(),close=vi.fn(); await show(api,close);
  await act(async()=>{button('Left hand').click();switchButton('Answer over the live connection').click();});
  expect(count()).toBe('2 changes');
  vi.mocked(api.putConfig).mockRejectedValueOnce(new Error('Fixture save failed'));
  await act(async()=>button('Save').click());
  expect(count()).toBe('1 change'); expect(host.textContent).toContain('Fixture save failed');
  expect(close).not.toHaveBeenCalled(); expect(loadUiHandedness()).toBe('left');
  await act(async()=>button('Save').click()); expect(count()).toBe('No changes'); expect(close).toHaveBeenCalledOnce();
});
it("blocks closing during a pending save", async()=>{
  const api=client(),close=vi.fn(); await show(api,close);
  await act(async()=>switchButton('Answer over the live connection').click());
  let finish!: (value:LcConfig)=>void;
  vi.mocked(api.putConfig).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await act(async()=>button('Save').click());
  expect(button('Cancel').disabled).toBe(true); expect(button('Back').disabled).toBe(true);
  await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));
  expect(close).not.toHaveBeenCalled();
  await act(async()=>finish(await api.getConfig())); expect(close).toHaveBeenCalledOnce();
});

it("saves selected palette styles together and All clears the selection", async()=>{
  const api=client(); await show(api);
  await act(async()=>button('Ink tools').click());
  const tag=(name:string)=>button(name);
  await act(async()=>{tag('Neon')!.click();tag('Dark')!.click();switchButton('Mix colours').click();});
  expect(tag('Neon')!.getAttribute('aria-pressed')).toBe('true');
  expect(tag('Dark')!.getAttribute('aria-pressed')).toBe('true');
  expect(tag('All')!.getAttribute('aria-pressed')).toBe('false');
  expect(loadPalettePrefs().tags).toEqual(['any']);
  await act(async()=>tag('All').click());
  expect(tag('All').getAttribute('aria-pressed')).toBe('true');
  expect(tag('Neon').getAttribute('aria-pressed')).toBe('false');
  expect(tag('Dark').getAttribute('aria-pressed')).toBe('false');
  await act(async()=>{tag('Neon').click();tag('Dark').click();});
  await act(async()=>button('Save').click());
  expect(loadPalettePrefs()).toMatchObject({tags:['neon','dark'],mixColours:true});
  expect(api.putConfig).not.toHaveBeenCalled();
});

it("resets one changed section without losing another section's drafts", async()=>{
  await show(client());
  await act(async()=>{button('Left hand').click();switchButton('Answer over the live connection').click();});
  await act(async()=>button('Ink tools').click());
  await act(async()=>button('Neon').click());
  expect(count()).toBe('3 changes');
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Reset Ink tools"]')!.click());
  expect(count()).toBe('2 changes');
  await act(async()=>button('UI').click());
  expect(button('Left hand').getAttribute('aria-checked')).toBe('true');
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Reset UI"]')!.click());
  expect(count()).toBe('No changes');
  expect(button('Right hand').getAttribute('aria-checked')).toBe('true');
});

it("keeps capture in Annotate and places all debug controls in Diagnostics", async()=>{
  await show(client());
  await act(async()=>button('Annotate').click());
  expect(host.querySelector('[aria-label="What a capture does"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="HUD refresh"]')).toBeNull();
  await act(async()=>button('Diagnostics').click());
  for(const label of ['HUD refresh','Frame overlay','Load bar','Flick landing preview','Sync pill on the board','Debug log'])
    expect(host.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
});
