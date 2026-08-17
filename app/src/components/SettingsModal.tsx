/**
 * Settings modal — edits the shared `config.toml` via the in-process router.
 * Backdrop blurs the board the same way problem-load transitions do.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { DevicePrefsDto, DlcStatus, LcClient } from "../api/client";
import type { CoachFlags, DatasetInfo, LcConfig, LcConfigPut, LlmStatus, ProviderConfig } from "../api/types";
import { DEFAULT_COACH_FLAGS } from "../api/types";
import { shouldDismissBackdrop } from "../util/backdropDismiss";
import { MorphBar } from "./MorphBar";
import { loadTestForwardMode, saveTestForwardMode, type TestForwardMode } from "../util/agentPrefs";
import { loadInkHandedness, saveInkHandedness, type InkHandedness } from "../util/inkHandedness";
import { loadInkToolPresets, saveInkToolPresets } from "../util/inkToolPresets";
import {
  loadInkPressureClip,
  saveInkPressureClip,
} from "../util/inkPressureClip";
import {
  loadInkSmoothing,
  loadInkSmoothingMode,
  saveInkSmoothing,
  saveInkSmoothingMode,
  type InkSmoothingMode,
} from "../util/inkSmoothingPref";
import {
  AUTOSAVE_CHOICES,
  AUTOSAVE_EVENT,
  loadAutosaveInterval,
  saveAutosaveInterval,
  type AutosaveInterval,
} from "../util/autosavePref";
import {
  ERASER_PARTIAL_EVENT,
  loadEraserPartial,
  saveEraserPartial,
} from "../util/eraserPartialPref";
import {
  CHROME_WAKE_EVENT,
  chromeWakeMarkerLabel,
  chromeWakeTintLabel,
  loadChromeWakeMarker,
  loadChromeWakeTint,
  saveChromeWakeMarker,
  saveChromeWakeTint,
  type ChromeWakeMarker,
  type ChromeWakeTint,
} from "../util/chromeWakePref";
import {
  loadInkSpeed,
  loadInkSpeedBlotBlend,
  saveInkSpeed,
  saveInkSpeedBlotBlend,
  INK_SPEED_BLOT_BLEND_EVENT,
} from "../util/inkSpeedPref";
import {
  loadInkBoldness,
  saveInkBoldness,
  INK_BOLDNESS_EVENT,
} from "../util/inkBoldnessPref";
import {
  captureModeLabel,
  captureWritesFile,
  loadCaptureMode,
  CAPTURE_COUNTDOWN_CHOICES,
  loadCaptureCountdown,
  loadCaptureDestination,
  loadCaptureFolder,
  saveCaptureCountdown,
  saveCaptureFolder,
  saveCaptureMode,
  saveCaptureDestination,
  type CaptureDestination,
  type CaptureMode,
} from "../util/capturePrefs";
import {
  loadPaletteTag,
  paletteTagLabel,
  savePaletteTag,
  PALETTE_TAGS,
  type PaletteTag,
} from "../util/palettePref";
import {
  loadOfflineMergePolicy,
  saveOfflineMergePolicy,
  type OfflineMergePolicy,
} from "../util/offlineMerge";
import { useIsMobile } from "../util/mobile";
import { estimateStorage, formatBytes, type StorageUsage } from "../util/storageQuota";
import {
  deviceRole,
  ensureDevicePrefs,
  loadDeviceId,
  saveThisDevicePrefs,
} from "../util/devicePrefs";
import { FEATURE_LEETCODE } from "../featureFlags";

type TabId = "workspace" | "personalise" | "ai" | "llm";

const TABS: { id: TabId; label: string }[] = [
  { id: "personalise", label: "Personalise" },
  { id: "ai", label: "AI Behavior" },
  ...(FEATURE_LEETCODE ? [{ id: "workspace" as const, label: "Workspace" }] : []),
  { id: "llm", label: "LLM" },
];

const SETTINGS_PAGE_TITLES: Record<string, string> = {
  paths: "Paths",
  datasets: "Datasets",
  writing: "Writing settings",
  storage: "Storage Settings",
  tests: "Test Cases",
  llm: "LLM",
};

const SettingsPageCtx = createContext<{
  page: string;
  open: (id: string) => void;
  host: HTMLElement | null;
}>({ page: "root", open: () => {}, host: null });

/**
 * A settings topic on the root list. Click morphs the window into that page;
 * Back on the header returns. Children portal into the morph sub-panel so the
 * accordion never grows in place.
 */
function SettingsFold({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  const { page, open, host } = useContext(SettingsPageCtx);
  return (
    <>
      <div className="lc-settings-fold">
        <button
          type="button"
          className="lc-settings-fold-summary"
          onClick={() => open(id)}
        >
          <span className="lc-settings-fold-chevron" aria-hidden />
          <span className="lc-settings-fold-title">{title}</span>
        </button>
      </div>
      {page === id && host ? createPortal(children, host) : null}
    </>
  );
}

const PROVIDERS = ["local", "ollama", "openai", "groq"] as const;
const MODES = ["ambient", "review", "bridge", "viz", "planner"] as const;

/**
 * Settings → AI Behavior, grouped by what the question actually is.
 *
 * Flat, these read as five unrelated switches, and "Plan the approaches first"
 * in particular looked like a mystery toggle rather than the one setting that
 * changes what the coach *knows* before it has seen anything. Three headings,
 * because there are three questions: what does it know going in, how does it
 * hold its ground, and how does it talk back.
 */
const COACH_FLAG_GROUPS: Array<{
  id: string;
  title: string;
  blurb: string;
  flags: Array<[keyof CoachFlags, string, string]>;
}> = [
  {
    id: "coach-knows",
    title: "What the agent knows before it looks",
    blurb:
      "Extra model calls made once per problem, before your board is read. Both cost a call, so both start off.",
    flags: [
      [
        "planner_enabled",
        "Plan the approaches first",
        "One call per problem, to the planner provider on the LLM tab, cataloging the approach families the problem admits — so a small local model is asked the narrow questions it is good at and a bigger one answers the broad one. Built from the statement and the sample cases only: it cannot reach a solution, and a test keeps it that way.",
      ],
      [
        "draw_review_enabled",
        "Check drawn diagrams",
        "After a diagram renders, look at the picture and redraw it once if it does not show what it claims. Needs a vision model on the viz provider.",
      ],
    ],
  },
  {
    id: "coach-reads",
    title: "How it reads your board",
    blurb: "What the agent does when the board argues for something.",
    flags: [
      [
        "approach_commitment",
        "Stick to one approach per board",
        "Keep the approach your board argues for, and say so when a change of board changes it — instead of quietly switching between valid approaches.",
      ],
    ],
  },
  {
    id: "coach-answers",
    title: "How its answers arrive",
    blurb: "Transport and transparency — neither changes what it says.",
    flags: [
      [
        "ws_runs",
        "Answer over the live connection",
        "Ask, Review, Draw and Lazy stream their stages back as they happen instead of arriving all at once.",
      ],
      [
        "process_events_ui",
        "Show what the agent is doing",
        "A collapsible list of stages and diagram tool calls above each answer.",
      ],
    ],
  },
];

/** What each coach mode is for, shown under its provider picker. */
const MODE_HINTS: Record<(typeof MODES)[number], string> = {
  ambient: "Every-2m glance at the board.",
  review: "The staged review, and Ask.",
  bridge: "The stepwise path shown after an explicit reveal.",
  viz: "Tool calls for diagrams and animations.",
  planner:
    "One call per problem that catalogs the approaches it admits. Point this at a frontier model to guide the local agent — it never sees or writes a solution.",
};

function llmServerHint(provider: "local" | "ollama" | "openai" | "groq"): string {
  switch (provider) {
    case "local":
    case "ollama":
      return "Usually http://localhost:11434/v1 when Ollama runs on this machine.";
    case "openai":
      return "OpenAI's cloud API. Requests leave from this app; the API key lives here too.";
    case "groq":
      return "Groq's cloud API. Requests leave from this app; the API key lives here too.";
  }
}

function emptyProvider(): ProviderConfig {
  return { base_url: "", model: "", vision_model: "" };
}

function emptyConfig(): LcConfig {
  return {
    data_json_dir: null,
    dataset_dirs: {},
    workspace_dir: "~/lc-workspace",
    stop_on_first_failure: false,
    default_provider: "local",
    local: emptyProvider(),
    ollama: emptyProvider(),
    openai: emptyProvider(),
    groq: emptyProvider(),
    modes: {
      ambient: "local",
      review: "local",
      bridge: "local",
      viz: "local",
      planner: "local",
    },
    serve_port: 7878,
    coach: { ...DEFAULT_COACH_FLAGS },
    token_set: false,
    openai_key_set: false,
    groq_key_set: false,
  };
}

/** Device-only prefs edited in Personalise — deferred until Save like config.toml. */
interface DevicePrefs {
  handedness: InkHandedness;
  /**
   * Hand a failed run to the coach without being asked.
   *
   * Used to be a "Failures" toggle in the chat composer, which put it beside
   * the flags that describe *this* message — but it describes what happens on a
   * test run minutes later, and it does not apply to the reading pads at all.
   * It belongs with the rest of the failure decision, under When a case fails.
   */
  testForward: TestForwardMode;
  captureMode: CaptureMode;
  captureDestination: CaptureDestination;
  captureFolder: string;
  captureCountdown: number;
  offlineMerge: OfflineMergePolicy;
  pressureClip: number;
  inkSmoothing: number;
  inkSmoothingMode: InkSmoothingMode;
  inkSpeed: number;
  /** Soften speed-ink dwell/join discs into the ribbon (0–1). */
  inkSpeedBlotBlend: number;
  /** Boost stroke opacity to compensate for soft speed blot blend (0–3). */
  inkBoldness: number;
  /** Eraser rubs pixels out, rather than taking whole strokes. */
  eraserPartial: boolean;
  /** Milliseconds between board autosaves; 0 is off. */
  autosaveMs: AutosaveInterval;
  /** ColourHunt tag the ink wheel asks for. */
  paletteTag: PaletteTag;
  /** Show ColorRadial on the drawing island (temporary colour until 1D Save). */
  colorWheelOnToolbar: boolean;
  /** Hub tap to apply a wheel pick. Off applies on the inner wedge. */
  tapOk: boolean;
  /** Hidden-chrome wake mark: smear, checkerboard pulse, or nothing. */
  chromeWake: ChromeWakeMarker;
  /** Recolor smear + checkerboard with a cycling gradient, or leave them mono. */
  chromeWakeTint: ChromeWakeTint;
}

function loadDevicePrefs(): DevicePrefs {
  return {
    handedness: loadInkHandedness(),
    testForward: loadTestForwardMode(),
    captureMode: loadCaptureMode(),
    captureDestination: loadCaptureDestination(),
    captureFolder: loadCaptureFolder(),
    captureCountdown: loadCaptureCountdown(),
    offlineMerge: loadOfflineMergePolicy(),
    pressureClip: loadInkPressureClip(),
    inkSmoothing: loadInkSmoothing(),
    inkSmoothingMode: loadInkSmoothingMode(),
    inkSpeed: loadInkSpeed(),
    inkSpeedBlotBlend: loadInkSpeedBlotBlend(),
    inkBoldness: loadInkBoldness(),
    eraserPartial: loadEraserPartial(),
    autosaveMs: loadAutosaveInterval(),
    paletteTag: loadPaletteTag(),
    colorWheelOnToolbar: loadInkToolPresets().colorWheelOnToolbar,
    tapOk: loadInkToolPresets().tapOk,
    chromeWake: loadChromeWakeMarker(),
    chromeWakeTint: loadChromeWakeTint(),
  };
}

function prefsEqual(a: DevicePrefs, b: DevicePrefs): boolean {
  return (
    a.handedness === b.handedness &&
    a.testForward === b.testForward &&
    a.captureMode === b.captureMode &&
    a.captureDestination === b.captureDestination &&
    a.captureFolder === b.captureFolder &&
    a.captureCountdown === b.captureCountdown &&
    a.offlineMerge === b.offlineMerge &&
    a.pressureClip === b.pressureClip &&
    a.inkSmoothing === b.inkSmoothing &&
    a.inkSmoothingMode === b.inkSmoothingMode &&
    a.inkSpeed === b.inkSpeed &&
    a.inkSpeedBlotBlend === b.inkSpeedBlotBlend &&
    a.inkBoldness === b.inkBoldness &&
    a.eraserPartial === b.eraserPartial &&
    a.autosaveMs === b.autosaveMs &&
    a.paletteTag === b.paletteTag &&
    a.colorWheelOnToolbar === b.colorWheelOnToolbar &&
    a.tapOk === b.tapOk &&
    a.chromeWake === b.chromeWake &&
    a.chromeWakeTint === b.chromeWakeTint
  );
}

function configEqual(a: LcConfig, b: LcConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface SettingsModalProps {
  open: boolean;
  client: LcClient;
  onClose: () => void;
  onSaved?: () => void;
  /** Open on a specific tab (e.g. LLM from the LLM gate). */
  initialTab?: TabId;
  /** Live coach / LLM reachability for the LLM tab badge. */
  coachStatus?: "unknown" | "online" | "offline";
  coachDetail?: string | null;
}

export function SettingsModal({
  open,
  client,
  onClose,
  onSaved,
  initialTab,
  coachStatus = "unknown",
  coachDetail = null,
}: SettingsModalProps) {
  const mobile = useIsMobile();
  const backdropDown = useRef(false);
  const [tab, setTab] = useState<TabId>(initialTab ?? "personalise");
  const [page, setPage] = useState("root");
  const [subHost, setSubHost] = useState<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<LcConfig>(emptyConfig);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Separate from `busy` so a slow/hung GET /config cannot leave Save stuck disabled. */
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerFocus, setProviderFocus] = useState<(typeof PROVIDERS)[number]>("local");
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState("");
  const [groqKeyDraft, setGroqKeyDraft] = useState("");
  const [clearOpenaiKey, setClearOpenaiKey] = useState(false);
  const [clearGroqKey, setClearGroqKey] = useState(false);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  /**
   * What this origin is using, read once when Personalise opens.
   *
   * Not polled: the numbers are deliberately coarse (the spec lets the browser
   * pad them so storage cannot be used to fingerprint across origins), so a
   * live counter would be false precision on a figure that only needs to answer
   * "am I near the wall?".
   */
  const [storage, setStorage] = useState<(StorageUsage & { persisted: boolean }) | null>(null);
  const [siblingDevices, setSiblingDevices] = useState<DevicePrefsDto[]>([]);
  const [handedness, setHandedness] = useState<InkHandedness>(() => loadInkHandedness());
  const [colorWheelOnToolbar, setColorWheelOnToolbar] = useState(
    () => loadInkToolPresets().colorWheelOnToolbar,
  );
  const [tapOk, setTapOk] = useState(() => loadInkToolPresets().tapOk);
  const [chromeWake, setChromeWake] = useState<ChromeWakeMarker>(() =>
    loadChromeWakeMarker(),
  );
  const [chromeWakeTint, setChromeWakeTint] = useState<ChromeWakeTint>(() =>
    loadChromeWakeTint(),
  );
  const [testForward, setTestForward] = useState<TestForwardMode>(() =>
    loadTestForwardMode(),
  );
  const [captureMode, setCaptureMode] = useState<CaptureMode>(() => loadCaptureMode());
  const [captureDestination, setCaptureDestination] = useState<CaptureDestination>(() =>
    loadCaptureDestination(),
  );
  const [captureFolder, setCaptureFolder] = useState(() => loadCaptureFolder());
  const [captureCountdown, setCaptureCountdown] = useState(() => loadCaptureCountdown());
  const [offlineMerge, setOfflineMerge] = useState<OfflineMergePolicy>(() =>
    loadOfflineMergePolicy(),
  );
  const [pressureClip, setPressureClip] = useState(() => loadInkPressureClip());
  const [inkSmoothing, setInkSmoothing] = useState(() => loadInkSmoothing());
  const [inkSmoothingMode, setInkSmoothingMode] = useState<InkSmoothingMode>(() =>
    loadInkSmoothingMode(),
  );
  const [inkSpeed, setInkSpeed] = useState(() => loadInkSpeed());
  const [inkSpeedBlotBlend, setInkSpeedBlotBlend] = useState(() => loadInkSpeedBlotBlend());
  const [inkBoldness, setInkBoldness] = useState(() => loadInkBoldness());
  const [eraserPartial, setEraserPartial] = useState(() => loadEraserPartial());
  const [autosaveMs, setAutosaveMs] = useState<AutosaveInterval>(() =>
    loadAutosaveInterval(),
  );
  /* Draft until Save — dirty detection includes this so Save enables. */
  const [paletteTag, setPaletteTag] = useState<PaletteTag>(() => loadPaletteTag());
  /** Last saved config + device prefs — Cancel restores these; Save advances them. */
  const [baselineConfig, setBaselineConfig] = useState<LcConfig>(emptyConfig);
  const [baselinePrefs, setBaselinePrefs] = useState<DevicePrefs>(loadDevicePrefs);
  const [dlcRows, setDlcRows] = useState<DlcStatus[]>([]);

  const refreshLlm = useCallback(async () => {
    try {
      setLlmStatus(await client.llmStatus());
    } catch {
      setLlmStatus(null);
    }
  }, [client]);

  /** Re-read on each visit to Personalise, so it reflects the session just saved. */
  useEffect(() => {
    if (tab !== "personalise") return;
    let cancelled = false;
    void (async () => {
      const usage = await estimateStorage();
      if (cancelled || !usage) return;
      let persisted = false;
      try {
        persisted = (await navigator.storage?.persisted?.()) ?? false;
      } catch {
        /* absent in some WebViews — the bar is still worth showing */
      }
      if (!cancelled) setStorage({ ...usage, persisted });
    })();
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const refreshDlc = useCallback(async () => {
    try {
      setDlcRows(await client.dlcStatus());
    } catch {
      setDlcRows([]);
    }
  }, [client]);

  useEffect(() => {
    if (!open || tab !== "workspace") return;
    void refreshDlc();
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<DlcStatus[]>("lc-dlc-status", (event) => {
        if (Array.isArray(event.payload)) setDlcRows(event.payload);
      }).then((unlisten) => {
        stop = unlisten;
      });
    });
    const timer = window.setInterval(() => void refreshDlc(), 1500);
    return () => {
      stop?.();
      window.clearInterval(timer);
    };
  }, [open, tab, refreshDlc]);

  const onDlcInstall = useCallback(
    (slug: string) => {
      void client.dlcInstall(slug).then((row) => {
        setDlcRows((current) => current.map((entry) => (entry.slug === slug ? row : entry)));
      }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [client],
  );

  const onDlcRemove = useCallback(
    (slug: string) => {
      void client.dlcRemove(slug).then((row) => {
        setDlcRows((current) => current.map((entry) => (entry.slug === slug ? row : entry)));
      }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [client],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setBusy("loading…");
    const prefs = loadDevicePrefs();
    setHandedness(prefs.handedness);
    setTestForward(prefs.testForward);
    setCaptureMode(prefs.captureMode);
    setCaptureDestination(prefs.captureDestination);
    setCaptureFolder(prefs.captureFolder);
    setCaptureCountdown(prefs.captureCountdown);
    setOfflineMerge(prefs.offlineMerge);
    setPressureClip(prefs.pressureClip);
    setInkSmoothing(prefs.inkSmoothing);
    setInkSmoothingMode(prefs.inkSmoothingMode);
    setInkSpeed(prefs.inkSpeed);
    setInkSpeedBlotBlend(prefs.inkSpeedBlotBlend);
    setInkBoldness(prefs.inkBoldness);
    setEraserPartial(prefs.eraserPartial);
    setAutosaveMs(prefs.autosaveMs);
    setPaletteTag(prefs.paletteTag);
    setColorWheelOnToolbar(prefs.colorWheelOnToolbar);
    setTapOk(prefs.tapOk);
    setChromeWake(prefs.chromeWake);
    setChromeWakeTint(prefs.chromeWakeTint);
    setBaselinePrefs(prefs);
    if (initialTab) setTab(initialTab);
    setPage("root");
    void (async () => {
      try {
        const cfg = await client.getConfig();
        if (!cancelled) {
          setDraft(cfg);
          setBaselineConfig(cfg);
          setOpenaiKeyDraft("");
          setGroqKeyDraft("");
          setClearOpenaiKey(false);
          setClearGroqKey(false);
          setBusy(null);
        }
        await refreshLlm();
        try {
          const all = await client.datasets();
          if (!cancelled) setDatasets(all);
        } catch {
          // An older daemon has no /datasets — the tab just says so.
          if (!cancelled) setDatasets([]);
        }
        try {
          await ensureDevicePrefs(client);
          const devices = await client.listDevices();
          if (!cancelled) setSiblingDevices(devices);
        } catch {
          if (!cancelled) setSiblingDevices([]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setBusy(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, client, refreshLlm, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (page !== "root") setPage("root");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, page, onClose]);

  if (!open) return null;

  const draftPrefs: DevicePrefs = {
    handedness,
    testForward,
    captureMode,
    captureDestination,
    captureFolder,
    captureCountdown,
    offlineMerge,
    pressureClip,
    inkSmoothing,
    inkSmoothingMode,
    inkSpeed,
    inkSpeedBlotBlend,
    inkBoldness,
    eraserPartial,
    autosaveMs,
    paletteTag,
    colorWheelOnToolbar,
    tapOk,
    chromeWake,
    chromeWakeTint,
  };
  const keysDirty =
    openaiKeyDraft.trim() !== "" ||
    groqKeyDraft.trim() !== "" ||
    clearOpenaiKey ||
    clearGroqKey;
  const dirty =
    !configEqual(draft, baselineConfig) || !prefsEqual(draftPrefs, baselinePrefs) || keysDirty;

  const patchProvider = (key: "local" | "ollama" | "openai" | "groq", patch: Partial<ProviderConfig>) => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const cancel = () => {
    // Nothing persisted mid-edit — closing drops the draft. Baseline stays on disk.
    onClose();
  };

  /** How long Save waits on PUT /config before surfacing an error. */
  const CONFIG_SAVE_TIMEOUT_MS = 30_000;

  const save = async (opts?: { close?: boolean }) => {
    const shouldClose = opts?.close !== false;
    if (!dirty) {
      if (shouldClose) onClose();
      return;
    }
    setSaving(true);
    setError(null);
    const prefsDirty = !prefsEqual(draftPrefs, baselinePrefs);
    const configDirty = !configEqual(draft, baselineConfig) || keysDirty;
    try {
      // Device prefs never need the daemon — persist them even if PUT /config fails.
      if (prefsDirty) {
        saveInkHandedness(handedness);
        saveTestForwardMode(testForward);
        saveCaptureMode(captureMode);
        saveCaptureDestination(captureDestination);
        saveCaptureFolder(captureFolder);
        saveCaptureCountdown(captureCountdown);
        saveOfflineMergePolicy(offlineMerge);
        saveInkPressureClip(pressureClip);
        saveInkSmoothing(inkSmoothing);
        saveInkSmoothingMode(inkSmoothingMode);
        saveInkSpeed(inkSpeed);
        saveInkSpeedBlotBlend(inkSpeedBlotBlend);
        saveInkBoldness(inkBoldness);
        saveEraserPartial(eraserPartial);
        saveAutosaveInterval(autosaveMs);
        savePaletteTag(paletteTag);
        saveInkToolPresets({
          ...loadInkToolPresets(),
          colorWheelOnToolbar,
          tapOk,
        });
        saveChromeWakeMarker(chromeWake);
        saveChromeWakeTint(chromeWakeTint);
        setBaselinePrefs(draftPrefs);
        void saveThisDevicePrefs(client).catch(() => {});
        window.dispatchEvent(
          new CustomEvent<InkHandedness>("lc-ink-handedness", { detail: handedness }),
        );
        window.dispatchEvent(
          new CustomEvent<TestForwardMode>("lc-agent-test-forward", {
            detail: testForward,
          }),
        );
        window.dispatchEvent(new CustomEvent("lc-ink-pressure-clip"));
        window.dispatchEvent(new CustomEvent("lc-ink-smoothing"));
        window.dispatchEvent(new CustomEvent("lc-ink-speed"));
        window.dispatchEvent(new CustomEvent(INK_SPEED_BLOT_BLEND_EVENT));
        window.dispatchEvent(new CustomEvent(INK_BOLDNESS_EVENT));
        window.dispatchEvent(new CustomEvent(ERASER_PARTIAL_EVENT));
        window.dispatchEvent(new CustomEvent(AUTOSAVE_EVENT));
        window.dispatchEvent(new CustomEvent(CHROME_WAKE_EVENT));
      }
      if (configDirty) {
        const payload: LcConfigPut = { ...draft };
        if (openaiKeyDraft.trim()) payload.openai_api_key = openaiKeyDraft.trim();
        else if (clearOpenaiKey) payload.openai_api_key = "";
        if (groqKeyDraft.trim()) payload.groq_api_key = groqKeyDraft.trim();
        else if (clearGroqKey) payload.groq_api_key = "";
        const saved = await client.putConfig(payload, { timeoutMs: CONFIG_SAVE_TIMEOUT_MS });
        setDraft(saved);
        setBaselineConfig(saved);
        setOpenaiKeyDraft("");
        setGroqKeyDraft("");
        setClearOpenaiKey(false);
        setClearGroqKey(false);
      }
      onSaved?.();
      if (shouldClose) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const startLlm = async () => {
    setBusy("starting local LLM…");
    setError(null);
    try {
      setLlmStatus(await client.llmStart());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const stopLlm = async () => {
    setBusy("stopping local LLM…");
    setError(null);
    try {
      setLlmStatus(await client.llmStop());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const provider = draft[providerFocus];
  const pageTitle =
    page === "root"
      ? "Settings"
      : (COACH_FLAG_GROUPS.find((group) => group.id === page)?.title ??
        SETTINGS_PAGE_TITLES[page] ??
        "Settings");

  return (
    <div
      className="lc-settings-backdrop"
      role="presentation"
      onPointerDown={(e) => {
        backdropDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const startedOnBackdrop = backdropDown.current;
        backdropDown.current = false;
        if (shouldDismissBackdrop(startedOnBackdrop, e.target, e.currentTarget)) cancel();
      }}
    >
      <div className="lc-settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="lc-settings-head">
          {page === "root" ? (
            <>
              <h2>Settings</h2>
              <p className="lc-muted">Synced with TUI via config.toml</p>
            </>
          ) : (
            <div className="lc-settings-head-row">
              <button type="button" className="lc-settings-back" onClick={() => setPage("root")}>
                Back
              </button>
              <h2>{pageTitle}</h2>
              <button
                type="button"
                className="lc-primary lc-settings-head-save"
                disabled={!dirty || saving}
                onClick={() => void save({ close: false })}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>

        <SettingsPageCtx.Provider value={{ page, open: setPage, host: subHost }}>
        <MorphBar
          active={page === "root" ? "root" : "sub"}
          axis="height"
          className="lc-settings-morph"
        >
        <div data-morph-id="root">
        <div className="lc-settings-tabs" role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? "lc-settings-tab is-active" : "lc-settings-tab"}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="lc-settings-body lc-scroll-pane">
          {error && <div className="lc-warning">{error}</div>}
          {busy && <div className="lc-muted">{busy}</div>}

          {tab === "workspace" && (
            <div className="lc-settings-fields">
              <SettingsFold id="paths" title="Paths">
              <label>
                <span>Problem set</span>
                <input
                  value={draft.data_json_dir ?? ""}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      data_json_dir: e.target.value.trim() ? e.target.value : null,
                    }))
                  }
                  placeholder="path to JSON corpus"
                />
                <p className="lc-settings-hint">
                  JSON corpus this machine indexes. Local files, not a sync hub.
                </p>
              </label>
              <label>
                <span>IDE workspace</span>
                <input
                  value={draft.workspace_dir}
                  onChange={(e) => setDraft((prev) => ({ ...prev, workspace_dir: e.target.value }))}
                />
                <p className="lc-settings-hint">
                  Working copy on this machine: <code>solution.py</code>, Open in IDE, board.json.
                </p>
              </label>
              </SettingsFold>

              <SettingsFold id="datasets" title="Datasets">
              <p className="lc-muted">
                Each problem set is indexed into its own table. By default a corpus lives in{" "}
                <code>&lt;problems folder&gt;/&lt;dataset&gt;/</code>; override it below when it
                lives somewhere else.
              </p>
              <div className="lc-settings-subhead">Optional corpora (DLC)</div>
              <p className="lc-settings-hint">
                LeetCode and LC + Tests ship in the app. KodCode, MS Python/Q, and DeepSeek
                download as jsonl zips (GitHub release <code>corpora-v1</code>), unpack, then
                index. Off until you install. KodCode is large.
              </p>
              {dlcRows.map((row) => {
                const working = ["downloading", "unpacking", "indexing"].includes(row.phase);
                const pct = row.progress >= 0 ? Math.round(row.progress * 100) : null;
                const label = working
                  ? row.phase === "downloading" && pct != null
                    ? `Downloading… ${pct}%`
                    : `${row.phase}…`
                  : row.installed
                    ? "Remove"
                    : "Install";
                return (
                  <div key={row.slug} className="lc-settings-dlc-row">
                    <span>
                      {row.label}
                      <span className="lc-settings-badge">
                        {row.count.toLocaleString()} indexed
                      </span>
                    </span>
                    <button
                      type="button"
                      className={
                        row.installed && !working ? "lc-hold-danger" : "lc-primary"
                      }
                      disabled={Boolean(busy) || working}
                      onClick={() =>
                        row.installed && !working
                          ? onDlcRemove(row.slug)
                          : onDlcInstall(row.slug)
                      }
                    >
                      {label}
                    </button>
                    {row.error && <p className="lc-warning">{row.error}</p>}
                  </div>
                );
              })}
              {datasets.length === 0 && (
                <p className="lc-muted">
                  This build does not report datasets — rebuild with the leetcode feature.
                </p>
              )}
              {datasets.map((entry) => (
                <label key={entry.id}>
                  <span>
                    {entry.label}
                    <span className="lc-settings-badge">
                      {entry.count.toLocaleString()} indexed
                    </span>
                  </span>
                  <input
                    value={draft.dataset_dirs[entry.id] ?? ""}
                    placeholder={entry.corpus_dir ?? `<problems folder>/${entry.id}`}
                    onChange={(e) =>
                      setDraft((prev) => {
                        const dirs = { ...prev.dataset_dirs };
                        if (e.target.value.trim()) dirs[entry.id] = e.target.value;
                        else delete dirs[entry.id];
                        return { ...prev, dataset_dirs: dirs };
                      })
                    }
                  />
                  <p className="lc-settings-hint">
                    <code>{entry.source}</code> — index with{" "}
                    <code>lc index --dataset {entry.id}</code>
                  </p>
                </label>
              ))}
              </SettingsFold>
            </div>
          )}

          {tab === "personalise" && (
            <div className="lc-settings-fields">
              <SettingsFold id="writing" title="Writing settings">
              <div className="lc-settings-subhead">Writing hand</div>
              <p className="lc-settings-hint">
                Tilts the colour picker so swatches sit clear of your writing hand, and
                mirrors the chrome — agent panel, board dock, toolbars and action sheets —
                to the same side. Saved on this device only — not in <code>config.toml</code>.
              </p>
              <div className="lc-settings-choice" role="radiogroup" aria-label="Writing hand">
                <button
                  type="button"
                  role="radio"
                  aria-checked={handedness === "right"}
                  className={
                    handedness === "right"
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setHandedness("right")}
                >
                  <strong>Right hand</strong>
                  <span className="lc-muted">Chrome sits below-right of the tip, panels on the right.</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={handedness === "left"}
                  className={
                    handedness === "left"
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setHandedness("left")}
                >
                  <strong>Left hand</strong>
                  <span className="lc-muted">Chrome sits below-left of the tip, panels mirrored left.</span>
                </button>
              </div>

              <div className="lc-settings-subhead">Hidden-controls marker</div>
              <p className="lc-settings-hint">
                When the eye is off screen, a mark can sit in that corner so you can find
                it again. Saved on this device only.
              </p>
              <div
                className="lc-settings-choice"
                role="radiogroup"
                aria-label="Hidden-controls marker"
              >
                {(
                  [
                    [
                      "smear",
                      "A blurred ghost of the eye — the current grey-black smear.",
                    ],
                    [
                      "pulse",
                      "The same checkerboard pulse as the tool-menu confirm, on that spot.",
                    ],
                    [
                      "off",
                      "Nothing on the page. Tap that corner anyway — for drawings the smear would sit on.",
                    ],
                  ] as Array<[ChromeWakeMarker, string]>
                ).map(([marker, blurb]) => (
                  <button
                    key={marker}
                    type="button"
                    role="radio"
                    aria-checked={chromeWake === marker}
                    className={
                      chromeWake === marker
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setChromeWake(marker)}
                  >
                    <strong>{chromeWakeMarkerLabel(marker)}</strong>
                    <span className="lc-muted">{blurb}</span>
                  </button>
                ))}
              </div>

              <div className="lc-settings-subhead">Marker colour</div>
              <p className="lc-settings-hint">
                Black and white is the grey smear and checkerboard. Rainbow pulse
                crawls the full ROYGBIV spectrum across both marks.
              </p>
              <div
                className="lc-settings-choice"
                role="radiogroup"
                aria-label="Hidden-controls marker colour"
              >
                {(
                  [
                    [
                      "mono",
                      "Grey smear and black-and-white checkerboard — the current marks.",
                    ],
                    [
                      "color",
                      "ROYGBIV crawl on the smear and the checkerboard — not black and white.",
                    ],
                  ] as Array<[ChromeWakeTint, string]>
                ).map(([tint, blurb]) => (
                  <button
                    key={tint}
                    type="button"
                    role="radio"
                    aria-checked={chromeWakeTint === tint}
                    className={
                      chromeWakeTint === tint
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setChromeWakeTint(tint)}
                  >
                    <strong>{chromeWakeTintLabel(tint)}</strong>
                    <span className="lc-muted">{blurb}</span>
                  </button>
                ))}
              </div>

              <div className="lc-settings-subhead">Photo settings</div>
              <p className="lc-settings-hint">
                What happens when you capture the board — entire or a region. Files are
                saved on this device only; the default destination is Photos.
              </p>
              <div
                className="lc-settings-choice"
                role="radiogroup"
                aria-label="What a capture does"
              >
                {(
                  [
                    [
                      "board",
                      "Place the capture on the board. No file is written.",
                    ],
                    [
                      "board-save",
                      "Place it on the board and save a PNG to this device.",
                    ],
                    [
                      "save",
                      "Save a PNG only — the board is left as it was.",
                    ],
                  ] as Array<[CaptureMode, string]>
                ).map(([mode, blurb]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={captureMode === mode}
                    className={
                      captureMode === mode
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setCaptureMode(mode)}
                  >
                    <strong>{captureModeLabel(mode)}</strong>
                    <span className="lc-muted">{blurb}</span>
                  </button>
                ))}
              </div>

              {captureWritesFile(captureMode) && (
                <>
                  <div className="lc-settings-subhead">Capture save location</div>
                  <div
                    className="lc-settings-choice"
                    role="radiogroup"
                    aria-label="Capture save location"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={captureDestination === "photos"}
                      className={
                        captureDestination === "photos"
                          ? "lc-settings-choice-option is-active"
                          : "lc-settings-choice-option"
                      }
                      onClick={() => setCaptureDestination("photos")}
                    >
                      <strong>Device photos</strong>
                      <span className="lc-muted">
                        Pictures library / Photos app (Pictures/lc). Default.
                      </span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={captureDestination === "downloads"}
                      className={
                        captureDestination === "downloads"
                          ? "lc-settings-choice-option is-active"
                          : "lc-settings-choice-option"
                      }
                      onClick={() => setCaptureDestination("downloads")}
                    >
                      <strong>Downloads</strong>
                      <span className="lc-muted">Write a PNG into the Downloads folder.</span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={captureDestination === "folder"}
                      className={
                        captureDestination === "folder"
                          ? "lc-settings-choice-option is-active"
                          : "lc-settings-choice-option"
                      }
                      onClick={() => setCaptureDestination("folder")}
                    >
                      <strong>A folder you pick</strong>
                      <span className="lc-muted">
                        Write PNGs into a directory you name below. Desktop app only.
                      </span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={captureDestination === "share"}
                      className={
                        captureDestination === "share"
                          ? "lc-settings-choice-option is-active"
                          : "lc-settings-choice-option"
                      }
                      onClick={() => setCaptureDestination("share")}
                    >
                      <strong>Share sheet</strong>
                      <span className="lc-muted">
                        Android only — hands the PNG to the system chooser. Elsewhere it
                        saves to Photos and tells you where.
                      </span>
                    </button>
                  </div>

                  {captureDestination === "folder" && (
                    <>
                      <p className="lc-settings-hint">
                        Absolute path. <code>~</code> works. The folder is created if it
                        does not exist; if the write fails the capture falls back to a
                        download and the toast says so.
                      </p>
                      <input
                        type="text"
                        value={captureFolder}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        placeholder="~/Pictures/lc-board"
                        aria-label="Capture folder"
                        onChange={(event) => setCaptureFolder(event.target.value)}
                      />
                    </>
                  )}

                  <div className="lc-settings-subhead">Capture countdown</div>
                  <p className="lc-settings-hint">
                    Seconds between pressing the shutter and the shot, so you can get out
                    of your own way. Tapping the countdown shoots immediately.
                  </p>
                  <div
                    className="lc-settings-choice lc-settings-choice-compact"
                    role="radiogroup"
                    aria-label="Capture countdown"
                  >
                    {CAPTURE_COUNTDOWN_CHOICES.map((seconds) => (
                      <button
                        key={seconds}
                        type="button"
                        role="radio"
                        aria-checked={captureCountdown === seconds}
                        className={
                          captureCountdown === seconds
                            ? "lc-settings-choice-option is-active"
                            : "lc-settings-choice-option"
                        }
                        onClick={() => setCaptureCountdown(seconds)}
                      >
                        <strong>{seconds === 0 ? "Off" : `${seconds}s`}</strong>
                      </button>
                    ))}
                  </div>
                </>
              )}

              <div className="lc-settings-subhead">Ink presets</div>
              <p className="lc-settings-hint">
                Six wedges per tool. Slot 1 is Global. Pen, highlighter and eraser
                live on the wheel — hold the preset name until it fills (or rest
                the nib without moving, 280ms when unlocked) to open it. A tap does
                nothing.
              </p>
              <div className="lc-settings-subhead">Tap OK</div>
              <p className="lc-settings-hint">
                Confirm the pair at the hub. Off applies when you release the
                inner wedge — outer tool first, then a colour. Hold until the
                wedge fills to edit, same as when OK is on. The tool you already
                have counts as the outer pick. Switching tools clears the colour;
                switching back is still the outer step. Saved on this device only.
              </p>
              <div
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Tap OK"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!tapOk}
                  className={
                    tapOk
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() => setTapOk(false)}
                >
                  <strong>Off</strong>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={tapOk}
                  className={
                    tapOk
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setTapOk(true)}
                >
                  <strong>On</strong>
                </button>
              </div>
              <div className="lc-settings-subhead">Colour wheel on toolbar</div>
              <p className="lc-settings-hint">
                Temporary colour — does not rewrite the active wedge until you Save
                in the preset editor. Saved on this device only.
              </p>
              <div
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Colour wheel on toolbar"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!colorWheelOnToolbar}
                  className={
                    colorWheelOnToolbar
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() => setColorWheelOnToolbar(false)}
                >
                  <strong>Off</strong>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={colorWheelOnToolbar}
                  className={
                    colorWheelOnToolbar
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setColorWheelOnToolbar(true)}
                >
                  <strong>On</strong>
                </button>
              </div>

              {/*
                What the ⟳ on the colour wheel asks for.
                
                The feed was queried with no tag at all, which is not "no
                preference" so much as "whatever the site sorts by" — and what
                came back was pastel after pastel. Any stays the default: a
                preference nobody asked for should not narrow what they get.
              */}
              <div className="lc-settings-subhead">Ink palettes</div>
              <p className="lc-settings-hint">
                What kind of colours the wheel pulls from ColorHunt when you ask
                it for another palette. Offline — or if the feed fails — a local
                list is used instead, and this tag does not apply.
              </p>
              <div
                className="lc-settings-choice lc-settings-choice-wrap"
                role="radiogroup"
                aria-label="Palette colours"
              >
                {PALETTE_TAGS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    role="radio"
                    aria-checked={paletteTag === tag}
                    className={
                      paletteTag === tag
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => {
                      setPaletteTag(tag);
                    }}
                  >
                    <strong>{paletteTagLabel(tag)}</strong>
                  </button>
                ))}
              </div>
              </SettingsFold>

              <SettingsFold id="storage" title="Storage Settings">
              <div className="lc-settings-subhead">Devices</div>
              <p className="lc-settings-hint">
                Personalise is per device. This one is {deviceRole()} ({loadDeviceId().slice(0, 8)}…).
                Others are listed, not merged.
              </p>
              <ul className="lc-settings-hint">
                <li>
                  {deviceRole()} · {loadDeviceId().slice(0, 8)}… · this device
                </li>
                {siblingDevices
                  .filter((dev) => dev.id !== loadDeviceId())
                  .map((dev) => (
                    <li key={dev.id}>
                      {dev.role} · {dev.id.slice(0, 8)}… ·{" "}
                      {new Date(dev.updated_at).toLocaleString()}
                    </li>
                  ))}
              </ul>
              <div className="lc-settings-subhead">Autosave</div>
              <p className="lc-settings-hint">
                How often the board writes itself down, so a crash or a closed lid
                costs nothing. This is not the same as saving: Discard still rolls
                back to where the session started, whatever the autosave has
                written since. Saved on this device.
              </p>
              <div
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Autosave interval"
              >
                {AUTOSAVE_CHOICES.map(([ms, label]) => (
                  <button
                    key={ms}
                    type="button"
                    role="radio"
                    aria-checked={autosaveMs === ms}
                    className={
                      autosaveMs === ms
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setAutosaveMs(ms)}
                  >
                    <strong>{label}</strong>
                  </button>
                ))}
              </div>

              <div className="lc-settings-subhead">Offline ↔ online boards</div>
              <p className="lc-settings-hint">
                When the tablet reconnects after working offline, how should local and server
                copies of the same problem board be reconciled? Saved on this device only.
              </p>
              <div className="lc-settings-choice" role="radiogroup" aria-label="Offline merge policy">
                {(
                  [
                    ["ask", "Ask each time", "Show a chooser when both sides have work."],
                    ["prefer-local", "Prefer this device", "Keep the tablet copy; overwrite the server."],
                    ["prefer-server", "Prefer the server", "Keep the PC copy; discard local edits."],
                  ] as const
                ).map(([id, label, hint]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={offlineMerge === id}
                    className={
                      offlineMerge === id
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setOfflineMerge(id)}
                  >
                    <strong>{label}</strong>
                    <span className="lc-muted">{hint}</span>
                  </button>
                ))}
              </div>

              <div className="lc-settings-subhead">Storage on this device</div>
              <p className="lc-settings-hint">
                Annotated documents, whiteboard notebooks, board images and any offline
                problem pack all share one budget. Handwriting is the expensive part — a
                heavily annotated page costs far more than the document under it.
              </p>
              {storage ? (
                <>
                  <div
                    className="lc-storage-bar"
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(storage.ratio * 100)}
                    aria-label="Storage used"
                  >
                    <div
                      className="lc-storage-bar-fill"
                      style={{ width: `${Math.max(1, Math.round(storage.ratio * 100))}%` }}
                    />
                  </div>
                  <p className="lc-muted">
                    {formatBytes(storage.usage)} used of {formatBytes(storage.quota)}
                    {storage.persisted ? " · kept when space runs short" : ""}
                  </p>
                </>
              ) : (
                <p className="lc-muted">This browser does not report a storage estimate.</p>
              )}
              </SettingsFold>
            </div>
          )}

          {tab === "ai" && (
            <div className="lc-settings-fields">
              {FEATURE_LEETCODE && (
              <SettingsFold id="tests" title="Test Cases">
              <div className="lc-settings-subhead">When a case fails</div>
              <div className="lc-settings-choice" role="radiogroup" aria-label="Test run mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!draft.stop_on_first_failure}
                  className={
                    draft.stop_on_first_failure
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() =>
                    setDraft((prev) => ({ ...prev, stop_on_first_failure: false }))
                  }
                >
                  <strong>Run every case</strong>
                  <span className="lc-muted">
                    Keep going after a failure and report the whole picture — “3/12 passed”.
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.stop_on_first_failure}
                  className={
                    draft.stop_on_first_failure
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setDraft((prev) => ({ ...prev, stop_on_first_failure: true }))}
                >
                  <strong>Stop at the first failure</strong>
                  <span className="lc-muted">
                    Quit as soon as a case fails. Faster on problems with hundreds of cases.
                  </span>
                </button>
              </div>
              <p className="lc-settings-hint">
                Applies to <strong>Run tests</strong>, <strong>Submit</strong>, and{" "}
                <code>lc test</code>. Running every case is what lets the agent pick a real
                counterexample, so leave it on unless a run is slow.
              </p>
              <div
                className="lc-settings-choice"
                role="radiogroup"
                aria-label="When a failed run should call the agent"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={testForward === "wait"}
                  className={
                    testForward === "wait"
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setTestForward("wait")}
                >
                  <strong>Wait</strong>
                  <span className="lc-muted">
                    Tests card in chat. Agent stays quiet until you ask.
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={testForward === "whole-run"}
                  className={
                    testForward === "whole-run"
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setTestForward("whole-run")}
                >
                  <strong>One request for the whole run</strong>
                  <span className="lc-muted">
                    One model call covering every failed case.
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={testForward === "per-case"}
                  className={
                    testForward === "per-case"
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setTestForward("per-case")}
                >
                  <strong>One request per failing case</strong>
                  <span className="lc-muted">
                    Separate model call for each red case.
                  </span>
                </button>
              </div>
              <p className="lc-settings-hint">
                Saved on this device only. The Tests card always posts. Problems only —
                pads have no test run to forward.
              </p>
              </SettingsFold>
              )}

              {COACH_FLAG_GROUPS.map((group) => (
                <SettingsFold key={group.id} id={group.id} title={group.title}>
                  <p className="lc-settings-hint">{group.blurb}</p>
                  <div className="lc-settings-choice">
                    {group.flags.map(([key, label, hint]) => {
                      const on = (draft.coach ?? DEFAULT_COACH_FLAGS)[key];
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={on}
                          className={
                            on
                              ? "lc-settings-choice-option is-active"
                              : "lc-settings-choice-option"
                          }
                          onClick={() =>
                            setDraft((prev) => {
                              const current = (prev.coach ?? DEFAULT_COACH_FLAGS)[key];
                              return {
                                ...prev,
                                coach: {
                                  ...DEFAULT_COACH_FLAGS,
                                  ...(prev.coach ?? {}),
                                  [key]: !current,
                                },
                              };
                            })
                          }
                        >
                          <strong>{label}</strong>
                          <span className="lc-muted">{hint}</span>
                        </button>
                      );
                    })}
                  </div>
                </SettingsFold>
              ))}
            </div>
          )}

          {tab === "llm" && (
            <div className="lc-settings-fields">
              <div className="lc-settings-callout" role="note">
                <strong>localhost means this machine</strong>
                <p>
                  The in-process daemon calls the LLM URL below.{" "}
                  <code>localhost</code> / <code>127.0.0.1</code> always mean{" "}
                  <strong>this app&apos;s machine</strong>
                  {mobile ? ", not a remote tablet" : ""}.
                </p>
              </div>

              <SettingsFold id="llm" title="LLM">
              <div className="lc-settings-subhead">Agent status</div>
              <p className="lc-agent-live" data-status={coachStatus}>
                <span className="lc-agent-live-dot" aria-hidden />
                <span>
                  {coachStatus === "online"
                    ? "Agent LLM online"
                    : coachStatus === "offline"
                      ? "Agent LLM offline"
                      : "Agent LLM status unknown"}
                </span>
              </p>
              {coachDetail && <p className="lc-settings-hint">{coachDetail}</p>}

              <div className="lc-settings-subhead">LLM</div>
              <label>
                <span>Default provider</span>
                <select
                  value={draft.default_provider}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, default_provider: e.target.value }))
                  }
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>

              <div className="lc-settings-provider-tabs" role="tablist">
                {PROVIDERS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="tab"
                    aria-selected={providerFocus === p}
                    className={
                      providerFocus === p
                        ? "lc-settings-subtab is-active"
                        : "lc-settings-subtab"
                    }
                    onClick={() => setProviderFocus(p)}
                  >
                    {p === "local"
                      ? "Local"
                      : p === "ollama"
                        ? "Ollama"
                        : p === "openai"
                          ? "OpenAI"
                          : "Groq"}
                  </button>
                ))}
              </div>

              <label>
                <span>LLM server URL</span>
                <input
                  value={provider.base_url}
                  onChange={(e) => patchProvider(providerFocus, { base_url: e.target.value })}
                  placeholder={
                    providerFocus === "openai"
                      ? "https://api.openai.com/v1"
                      : providerFocus === "groq"
                        ? "https://api.groq.com/openai/v1"
                        : "http://localhost:11434/v1"
                  }
                />
                <p className="lc-settings-hint">{llmServerHint(providerFocus)}</p>
              </label>
              <label>
                <span>Chat model</span>
                <input
                  value={provider.model}
                  onChange={(e) => patchProvider(providerFocus, { model: e.target.value })}
                />
              </label>
              <label>
                <span>Vision model</span>
                <input
                  value={provider.vision_model}
                  onChange={(e) =>
                    patchProvider(providerFocus, { vision_model: e.target.value })
                  }
                  placeholder="(same as chat model)"
                />
                <p className="lc-settings-hint">
                  Separate vision model for PNG board captures. Leave empty to reuse the chat model.
                </p>
              </label>

              {(providerFocus === "openai" || providerFocus === "groq") && (
                <label>
                  <span>API key</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={providerFocus === "openai" ? openaiKeyDraft : groqKeyDraft}
                    onChange={(e) => {
                      if (providerFocus === "openai") {
                        setOpenaiKeyDraft(e.target.value);
                        setClearOpenaiKey(false);
                      } else {
                        setGroqKeyDraft(e.target.value);
                        setClearGroqKey(false);
                      }
                    }}
                    placeholder={
                      (providerFocus === "openai" ? draft.openai_key_set : draft.groq_key_set)
                        ? "leave blank to keep the stored key"
                        : providerFocus === "openai"
                          ? "sk-…"
                          : "gsk_…"
                    }
                  />
                  <p className="lc-settings-hint">
                    Stored in this device&apos;s config.toml. Env{" "}
                    {providerFocus === "openai" ? "OPENAI_API_KEY" : "GROQ_API_KEY"} wins when
                    set. GET never returns the secret.
                  </p>
                  {(providerFocus === "openai" ? draft.openai_key_set : draft.groq_key_set) && (
                    <button
                      type="button"
                      className="lc-secondary"
                      onClick={() => {
                        if (providerFocus === "openai") {
                          setOpenaiKeyDraft("");
                          setClearOpenaiKey(true);
                        } else {
                          setGroqKeyDraft("");
                          setClearGroqKey(true);
                        }
                      }}
                    >
                      Clear stored key
                    </button>
                  )}
                  {(providerFocus === "openai" ? clearOpenaiKey : clearGroqKey) && (
                    <p className="lc-muted">Stored key will be cleared on Save.</p>
                  )}
                </label>
              )}

              <div className="lc-settings-subhead">Agent mode providers</div>
              {MODES.map((mode) => (
                <label key={mode}>
                  <span>{mode}</span>
                  <select
                    value={draft.modes[mode]}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        modes: { ...prev.modes, [mode]: e.target.value },
                      }))
                    }
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <p className="lc-settings-hint">{MODE_HINTS[mode]}</p>
                </label>
              ))}

              <div className="lc-settings-subhead">Local LLM process</div>
              <p className="lc-settings-hint">
                Starts or stops the bundled local model on this machine.
              </p>
              <p className="lc-muted">
                {llmStatus?.detail ?? "Status unknown"}
                {llmStatus?.pid != null ? ` · pid ${llmStatus.pid}` : ""}
              </p>
              <div className="lc-settings-actions-row">
                <button type="button" className="lc-secondary" disabled={!!busy} onClick={() => void startLlm()}>
                  Start local LLM
                </button>
                <button type="button" className="lc-secondary" disabled={!!busy} onClick={() => void stopLlm()}>
                  Stop local LLM
                </button>
                <button type="button" className="lc-secondary" disabled={!!busy} onClick={() => void refreshLlm()}>
                  Refresh
                </button>
              </div>
              </SettingsFold>
            </div>
          )}
        </div>

        <div className="lc-settings-foot">
          <button type="button" className="lc-secondary" onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className="lc-primary"
            disabled={!dirty || saving}
            onClick={() => void save({ close: true })}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        </div>
        <div data-morph-id="sub">
          {error && (
            <div className="lc-warning lc-settings-sub-error">{error}</div>
          )}
          <div className="lc-settings-page lc-settings-fields" ref={setSubHost} />
        </div>
        </MorphBar>
        </SettingsPageCtx.Provider>
      </div>
    </div>
  );
}
