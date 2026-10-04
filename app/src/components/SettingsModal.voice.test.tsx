/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsModal } from "./SettingsModal";
import { DEFAULT_COACH_FLAGS, type LcConfig, type LcConfigPut } from "../api/types";
import type { LcClient } from "../api/client";

vi.mock("../util/devicePrefs", async importOriginal => ({
  ...await importOriginal<typeof import("../util/devicePrefs")>(),
  ensureDevicePrefs: vi.fn(async () => null), saveThisDevicePrefs: vi.fn(async () => null),
}));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  });
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function client() {
  const endpoint = { base_url: "http://fixture", model: "test", vision: false, vision_model: "" };
  const config = {
    local: endpoint, ollama: endpoint, openai: endpoint, groq: endpoint, coach: { ...DEFAULT_COACH_FLAGS },
    modes: { ambient: "local", review: "local", bridge: "local", viz: "local", planner: "local" },
    dataset_dirs: {}, workspace_dir: "test", serve_port: 7878, default_provider: "local",
  } as LcConfig;
  return {
    getConfig: vi.fn(async () => config), putConfig: vi.fn(async () => config), lanBaseUrl: vi.fn(async () => "http://fixture"),
    llmStatus: vi.fn(async () => ({ running: false })), bootNotice: vi.fn(async () => null), datasets: vi.fn(async () => []),
    listDevices: vi.fn(async () => []),
    listModels: vi.fn(async () => ({ provider: "local", base_url: "", models_dir: "", server_reachable: false, models: [], notes: [] })),
  } as unknown as LcClient;
}

function fold(title: string) {
  return [...host.querySelectorAll<HTMLElement>(".lc-settings-fold")].find(
    (node) => node.querySelector(".lc-settings-fold-title")?.textContent === title,
  )!;
}

function radio(label: string) {
  return [...fold("Voice dictation").querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (button) => button.querySelector("strong")?.textContent === label,
  )!;
}

function save() {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Save")!;
}

async function openVoice() {
  const api = client();
  await act(async () => root.render(<SettingsModal open client={api} onClose={() => {}} />));
  await act(async () => {});
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.trim() === "LLM")!;
  await act(async () => tab.click());
  const summary = fold("Voice dictation").querySelector<HTMLButtonElement>(".lc-settings-fold-summary")!;
  await act(async () => summary.click());
  return api;
}

async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("shows Voice dictation in the LLM tab, and saving Groq sends the engine and key", async () => {
  const api = await openVoice();
  const voice = fold("Voice dictation");
  expect(voice).toBeTruthy();
  expect(radio("Android").getAttribute("aria-checked")).toBe("true");
  expect(voice.querySelector('input[type="password"]')).toBeNull();
  await act(async () => radio("Groq").click());
  expect(voice.querySelector('input[type="password"]')).not.toBeNull();
  expect([...voice.querySelectorAll("label span")].some((node) => node.textContent === "Model")).toBe(true);
  expect(voice.querySelector(".lc-settings-fold-header")?.getAttribute("data-changed")).toBe("true");
  await fill(voice.querySelector<HTMLInputElement>('input[type="password"]')!, "gsk_test");
  await act(async () => save().click());
  expect(api.putConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      voice: expect.objectContaining({ engine: "groq" }),
      groq_api_key: "gsk_test",
    }),
    { timeoutMs: 30000 },
  );
});

it("sends deepgram_api_key when Deepgram is picked and a key is typed", async () => {
  const api = await openVoice();
  await act(async () => radio("Deepgram").click());
  await fill(fold("Voice dictation").querySelector<HTMLInputElement>('input[type="password"]')!, "dg_test");
  await act(async () => save().click());
  const payload = vi.mocked(api.putConfig).mock.calls[0][0] as LcConfigPut;
  expect(payload.deepgram_api_key).toBe("dg_test");
  expect(payload.voice?.engine).toBe("deepgram");
});

it("sends voice.cleanup local when Local is picked on the clean-up pass", async () => {
  const api = await openVoice();
  const group = fold("Voice dictation").querySelector<HTMLElement>('[aria-label="Clean-up pass"]')!;
  const choice = (label: string) => [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (button) => button.querySelector("strong")?.textContent === label,
  )!;
  expect(choice("Off").getAttribute("aria-checked")).toBe("true");
  await act(async () => choice("Local").click());
  await act(async () => save().click());
  const payload = vi.mocked(api.putConfig).mock.calls[0][0] as LcConfigPut;
  expect(payload.voice?.cleanup).toBe("local");
});

it("renders Android for an older config and omits voice when that group is left alone", async () => {
  const api = await openVoice();
  expect(radio("Android").getAttribute("aria-checked")).toBe("true");
  const llm = fold("LLM").querySelector<HTMLButtonElement>(".lc-settings-fold-summary")!;
  await act(async () => llm.click());
  const select = fold("LLM").querySelector("select")!;
  await act(async () => {
    select.value = "openai";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => save().click());
  const payload = vi.mocked(api.putConfig).mock.calls[0][0] as LcConfigPut;
  expect(payload).not.toHaveProperty("voice");
  expect(payload.default_provider).toBe("openai");
});
