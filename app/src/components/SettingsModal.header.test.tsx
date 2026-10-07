/** @vitest-environment jsdom */
import { loadHeaderModes } from "../util/headerModesPref";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsModal } from "./SettingsModal";
import { DEFAULT_COACH_FLAGS, type LcConfig } from "../api/types";
import type { LcClient } from "../api/client";

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
const count = () => host.querySelector('.lc-settings-change-count')?.textContent;
async function show(api:LcClient,onClose=()=>{}) {
  await act(async()=>root.render(<SettingsModal open client={api} onClose={onClose}/>));
  await act(async()=>button("UI").click());
}
it("keeps header visibility as a draft on Cancel and persists each mode on Save", async()=>{
  const api=client(),close=vi.fn(); await show(api,close);
  const toggle=(mode:string)=>host.querySelector<HTMLButtonElement>(`[aria-label="Show ${mode} in header"]`)!;
  for (const mode of ["Annotate","Whiteboard","Practice","Web","Explore"]) expect(toggle(mode).getAttribute("aria-checked")).toBe("true");
  await act(async()=>{toggle("Web").click();toggle("Explore").click();});
  expect(count()).toBe("2 changes"); expect(loadHeaderModes().web).toBe(true);
  await act(async()=>button("Cancel").click());
  expect(loadHeaderModes().explore).toBe(true); expect(close).toHaveBeenCalledOnce();
  await act(async()=>root.render(<SettingsModal open={false} client={api} onClose={close}/>));
  await show(api,close);
  expect(toggle("Web").getAttribute("aria-checked")).toBe("true");
  await act(async()=>{toggle("Web").click();toggle("Explore").click();});
  await act(async()=>button("Save").click());
  expect(loadHeaderModes()).toEqual({annotate:true,whiteboard:true,practice:true,web:false,explore:false});
  expect(api.putConfig).not.toHaveBeenCalled();
});
