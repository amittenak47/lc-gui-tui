/**
 * Settings modal — edits the shared `config.toml` via `lc serve`.
 * Backdrop blurs the board the same way problem-load transitions do.
 */

import { useCallback, useEffect, useState } from "react";

import type { LcClient } from "../api/client";
import type { CoachFlags, DatasetInfo, LcConfig, LlmStatus, ProviderConfig } from "../api/types";
import { DEFAULT_COACH_FLAGS } from "../api/types";
import { HoldButton } from "./HoldButton";
import { loadInkHandedness, saveInkHandedness, type InkHandedness } from "../util/inkHandedness";
import {
  loadInkPressureClip,
  pressureClipFromPercent,
  pressureClipToPercent,
  saveInkPressureClip,
} from "../util/inkPressureClip";
import {
  loadInkSmoothing,
  loadInkSmoothingMode,
  saveInkSmoothing,
  saveInkSmoothingMode,
  smoothingFromPercent,
  smoothingToPercent,
  type InkSmoothingMode,
} from "../util/inkSmoothingPref";
import {
  loadInkSpeed,
  saveInkSpeed,
  speedInkFromPercent,
  speedInkToPercent,
} from "../util/inkSpeedPref";
import {
  loadAutoSaveCaptures,
  CAPTURE_COUNTDOWN_CHOICES,
  loadCaptureCountdown,
  loadCaptureDestination,
  loadCaptureFolder,
  saveCaptureCountdown,
  saveCaptureFolder,
  saveAutoSaveCaptures,
  saveCaptureDestination,
  type CaptureDestination,
} from "../util/capturePrefs";
import {
  loadOfflineMergePolicy,
  saveOfflineMergePolicy,
  type OfflineMergePolicy,
} from "../util/offlineMerge";
import { offlinePackMeta } from "../util/offlineCorpus";
import { offlinePackDownloader } from "../util/offlinePackDownload";
import { useIsMobile } from "../util/mobile";

type TabId = "workspace" | "personalise" | "server";

const PRESSURE_CLIP_STEPS = [30, 40, 50, 60, 70, 80, 90, 100] as const;

const TABS: { id: TabId; label: string }[] = [
  { id: "personalise", label: "Personalise" },
  { id: "workspace", label: "Workspace" },
  { id: "server", label: "Server" },
];

const PROVIDERS = ["local", "ollama", "openai", "groq"] as const;
const MODES = ["ambient", "review", "bridge", "viz", "planner"] as const;

/** Settings → Coach, in the order they are worth explaining. */
const COACH_FLAGS: Array<[keyof CoachFlags, string, string]> = [
  [
    "ws_runs",
    "Answer over the live connection",
    "Ask, Review, Draw and Lazy stream their stages back as they happen instead of arriving all at once.",
  ],
  [
    "process_events_ui",
    "Show what the coach is doing",
    "A collapsible list of stages and diagram tool calls above each answer.",
  ],
  [
    "approach_commitment",
    "Stick to one approach per board",
    "Coach the approach your board argues for, and say so when a change of board changes it — instead of quietly switching between valid approaches.",
  ],
  [
    "planner_enabled",
    "Plan the approaches first",
    "One call per problem, to the planner provider below, cataloging the approach families it admits. Never sees or writes a solution.",
  ],
  [
    "draw_review_enabled",
    "Check drawn diagrams",
    "After a diagram renders, look at the picture and redraw it once if it does not show what it claims. Needs a vision model on the viz provider.",
  ],
];

/** What each coach mode is for, shown under its provider picker. */
const MODE_HINTS: Record<(typeof MODES)[number], string> = {
  ambient: "Every-2m glance at the board.",
  review: "The staged review, and Ask.",
  bridge: "The stepwise path shown after an explicit reveal.",
  viz: "Tool calls for diagrams and animations.",
  planner:
    "One call per problem that catalogs the approaches it admits. Point this at a frontier model to guide the local coach — it never sees or writes a solution.",
};

function llmServerHint(provider: "local" | "ollama" | "openai" | "groq"): string {
  switch (provider) {
    case "local":
    case "ollama":
      return "Usually http://localhost:11434/v1 when Ollama runs on the same machine as lc serve.";
    case "openai":
      return "OpenAI's cloud API. Requests still leave from the PC running lc serve; the API key lives there too.";
    case "groq":
      return "Groq's cloud API. Requests still leave from the PC running lc serve; the API key lives there too.";
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
    python_executable: "python",
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
  };
}

/** Device-only prefs edited in Personalise — deferred until Save like config.toml. */
interface DevicePrefs {
  handedness: InkHandedness;
  autoSaveCaptures: boolean;
  captureDestination: CaptureDestination;
  captureFolder: string;
  captureCountdown: number;
  offlineMerge: OfflineMergePolicy;
  pressureClip: number;
  inkSmoothing: number;
  inkSmoothingMode: InkSmoothingMode;
  inkSpeed: number;
}

function loadDevicePrefs(): DevicePrefs {
  return {
    handedness: loadInkHandedness(),
    autoSaveCaptures: loadAutoSaveCaptures(),
    captureDestination: loadCaptureDestination(),
    captureFolder: loadCaptureFolder(),
    captureCountdown: loadCaptureCountdown(),
    offlineMerge: loadOfflineMergePolicy(),
    pressureClip: loadInkPressureClip(),
    inkSmoothing: loadInkSmoothing(),
    inkSmoothingMode: loadInkSmoothingMode(),
    inkSpeed: loadInkSpeed(),
  };
}

function prefsEqual(a: DevicePrefs, b: DevicePrefs): boolean {
  return (
    a.handedness === b.handedness &&
    a.autoSaveCaptures === b.autoSaveCaptures &&
    a.captureDestination === b.captureDestination &&
    a.captureFolder === b.captureFolder &&
    a.captureCountdown === b.captureCountdown &&
    a.offlineMerge === b.offlineMerge &&
    a.pressureClip === b.pressureClip &&
    a.inkSmoothing === b.inkSmoothing &&
    a.inkSmoothingMode === b.inkSmoothingMode &&
    a.inkSpeed === b.inkSpeed
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
  /** Open on a specific tab (e.g. Server from the LLM gate). */
  initialTab?: TabId;
  /** Live coach / LLM reachability for the Server tab badge. */
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
  const [tab, setTab] = useState<TabId>(initialTab ?? "personalise");
  const [draft, setDraft] = useState<LcConfig>(emptyConfig);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Separate from `busy` so a slow/hung GET /config cannot leave Save stuck disabled. */
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerFocus, setProviderFocus] = useState<"local" | "ollama" | "openai">("local");
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  /** Host / port / six-digit code to type on a tablet — null until loaded. */
  const [pairInfo, setPairInfo] = useState<{
    code: string | null;
    host: string | null;
    port: number;
  } | null>(null);
  const [handedness, setHandedness] = useState<InkHandedness>(() => loadInkHandedness());
  const [autoSaveCaptures, setAutoSaveCaptures] = useState(() => loadAutoSaveCaptures());
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
  /** Last saved config + device prefs — Cancel restores these; Save advances them. */
  const [baselineConfig, setBaselineConfig] = useState<LcConfig>(emptyConfig);
  const [baselinePrefs, setBaselinePrefs] = useState<DevicePrefs>(loadDevicePrefs);
  const [packMeta, setPackMeta] = useState<{
    built_at: number;
    problemCount: number;
  } | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);
  const [packProgress, setPackProgress] = useState(0);
  const [packIndeterminate, setPackIndeterminate] = useState(false);
  const [packResumable, setPackResumable] = useState(false);
  const [packInfo, setPackInfo] = useState<string | null>(null);
  const [packMode, setPackMode] = useState<"full" | "delta" | null>(null);

  const refreshLlm = useCallback(async () => {
    try {
      setLlmStatus(await client.llmStatus());
    } catch {
      setLlmStatus(null);
    }
  }, [client]);

  useEffect(() => {
    return offlinePackDownloader.subscribe((snap) => {
      setPackBusy(snap.phase === "running");
      setPackProgress(snap.progress);
      setPackIndeterminate(snap.indeterminate);
      setPackResumable(snap.resumable || snap.phase === "paused");
      setPackInfo(snap.info);
      setPackMode(snap.mode);
      if (snap.phase === "error") setPackError(snap.error);
      else if (snap.phase === "running" || snap.phase === "done") {
        setPackError(null);
      }
      if (snap.phase === "done") {
        void offlinePackMeta().then((meta) => {
          if (meta) {
            setPackMeta({ built_at: meta.built_at, problemCount: meta.problemCount });
          }
        });
      }
    });
  }, []);

  const packPct = Math.round(packProgress * 100);
  const packActive = packBusy || packResumable;
  const packLabel = packBusy
    ? packIndeterminate
      ? "Downloading…"
      : `Downloading… ${packPct}%`
    : packResumable
      ? `Resume download${packProgress > 0 ? ` (${packPct}%)` : ""}`
      : packMeta
        ? "Refresh offline pack"
        : "Download offline pack";

  const onPackTap = useCallback(() => {
    if (busy) return;
    if (packBusy) {
      offlinePackDownloader.pause();
      return;
    }
    setPackError(null);
    setPackInfo(null);
    void offlinePackDownloader.start(client, { delta: Boolean(packMeta) });
  }, [busy, client, packBusy, packMeta]);

  const onPackAbort = useCallback(() => {
    if (!packActive) return;
    void offlinePackDownloader.abort();
  }, [packActive]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setBusy("loading…");
    const prefs = loadDevicePrefs();
    setHandedness(prefs.handedness);
    setAutoSaveCaptures(prefs.autoSaveCaptures);
    setCaptureDestination(prefs.captureDestination);
    setCaptureFolder(prefs.captureFolder);
    setCaptureCountdown(prefs.captureCountdown);
    setOfflineMerge(prefs.offlineMerge);
    setPressureClip(prefs.pressureClip);
    setInkSmoothing(prefs.inkSmoothing);
    setInkSmoothingMode(prefs.inkSmoothingMode);
    setInkSpeed(prefs.inkSpeed);
    setBaselinePrefs(prefs);
    if (initialTab) setTab(initialTab);
    void offlinePackMeta().then((meta) => {
      if (!cancelled && meta) {
        setPackMeta({ built_at: meta.built_at, problemCount: meta.problemCount });
      }
    });
    void (async () => {
      try {
        const cfg = await client.getConfig();
        if (!cancelled) {
          setDraft(cfg);
          setBaselineConfig(cfg);
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
          const pair = await client.pairCode();
          if (!cancelled) setPairInfo(pair);
        } catch {
          // An older daemon has no /pair/code — the Serve tab just says so.
          if (!cancelled) setPairInfo(null);
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

  if (!open) return null;

  const draftPrefs: DevicePrefs = {
    handedness,
    autoSaveCaptures,
    captureDestination,
    captureFolder,
    captureCountdown,
    offlineMerge,
    pressureClip,
    inkSmoothing,
    inkSmoothingMode,
    inkSpeed,
  };
  const dirty =
    !configEqual(draft, baselineConfig) || !prefsEqual(draftPrefs, baselinePrefs);

  const patchProvider = (key: "local" | "ollama" | "openai" | "groq", patch: Partial<ProviderConfig>) => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const cancel = () => {
    // Nothing persisted mid-edit — closing drops the draft. Baseline stays on disk.
    onClose();
  };

  const save = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    const prefsDirty = !prefsEqual(draftPrefs, baselinePrefs);
    const configDirty = !configEqual(draft, baselineConfig);
    try {
      // Device prefs never need the daemon — persist them even if PUT /config fails.
      if (prefsDirty) {
        saveInkHandedness(handedness);
        saveAutoSaveCaptures(autoSaveCaptures);
        saveCaptureDestination(captureDestination);
        saveCaptureFolder(captureFolder);
        saveCaptureCountdown(captureCountdown);
        saveOfflineMergePolicy(offlineMerge);
        saveInkPressureClip(pressureClip);
        saveInkSmoothing(inkSmoothing);
        saveInkSmoothingMode(inkSmoothingMode);
        saveInkSpeed(inkSpeed);
        setBaselinePrefs(draftPrefs);
        window.dispatchEvent(
          new CustomEvent<InkHandedness>("lc-ink-handedness", { detail: handedness }),
        );
        window.dispatchEvent(new CustomEvent("lc-ink-pressure-clip"));
        window.dispatchEvent(new CustomEvent("lc-ink-smoothing"));
        window.dispatchEvent(new CustomEvent("lc-ink-speed"));
      }
      if (configDirty) {
        const saved = await client.putConfig(draft);
        setDraft(saved);
        setBaselineConfig(saved);
      }
      onSaved?.();
      setSaving(false);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  return (
    <div
      className="lc-settings-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="lc-settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="lc-settings-head">
          <h2>Settings</h2>
          <p className="lc-muted">Synced with TUI via config.toml</p>
        </div>

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

        <div className="lc-settings-body">
          {error && <div className="lc-warning">{error}</div>}
          {busy && <div className="lc-muted">{busy}</div>}

          {tab === "workspace" && (
            <div className="lc-settings-fields">
              <div className="lc-settings-subhead">Paths</div>
              <label>
                <span>Problems folder</span>
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
                  Folder of problem JSON files — the same corpus the TUI indexes.
                </p>
              </label>
              <label>
                <span>Workspace dir</span>
                <input
                  value={draft.workspace_dir}
                  onChange={(e) => setDraft((prev) => ({ ...prev, workspace_dir: e.target.value }))}
                />
                <p className="lc-settings-hint">
                  Where generated solve folders go (~/lc-workspace/&lt;task&gt;).
                </p>
              </label>
              <label>
                <span>Python executable</span>
                <input
                  value={draft.python_executable}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, python_executable: e.target.value }))
                  }
                />
                <p className="lc-settings-hint">Python used to run tests.</p>
              </label>

              <div className="lc-settings-subhead">Datasets</div>
              <p className="lc-muted">
                Each problem set is indexed into its own table. By default a corpus lives in{" "}
                <code>&lt;problems folder&gt;/&lt;dataset&gt;/</code>; override it below when it
                lives somewhere else.
              </p>
              {datasets.length === 0 && (
                <p className="lc-muted">
                  This daemon does not report datasets — update <code>lc serve</code>.
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
            </div>
          )}

          {tab === "personalise" && (
            <div className="lc-settings-fields">
              <div className="lc-settings-subhead">Writing hand</div>
              <p className="lc-settings-hint">
                Tilts the colour picker so swatches sit clear of your writing hand.
                Saved on this device only — not in <code>config.toml</code>.
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
                  <span className="lc-muted">Chrome sits below-right of the tip.</span>
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
                  <span className="lc-muted">Chrome sits below-left of the tip.</span>
                </button>
              </div>

              <div className="lc-settings-subhead">Screen captures</div>
              <p className="lc-settings-hint">
                When you capture the board (entire or a region), also save a PNG on this device.
                Default destination is Photos. Saved on this device only.
              </p>
              <div
                className="lc-settings-choice"
                role="radiogroup"
                aria-label="Auto-save screen captures"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={autoSaveCaptures}
                  className={
                    autoSaveCaptures
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setAutoSaveCaptures(true)}
                >
                  <strong>Auto-save captures</strong>
                  <span className="lc-muted">
                    Also place the image on the board and save a PNG to this device.
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!autoSaveCaptures}
                  className={
                    !autoSaveCaptures
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setAutoSaveCaptures(false)}
                >
                  <strong>Board only</strong>
                  <span className="lc-muted">Place the capture on the board; do not save a file.</span>
                </button>
              </div>

              {autoSaveCaptures && (
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

              <div className="lc-settings-subhead">Pressure clip</div>
              <p className="lc-settings-hint">
                How hard you press before the pen reads as &ldquo;full&rdquo; pressure. Lower
                values make light strokes reach max ink sooner — useful on a stiff nib or a tablet
                that reports low pressure. Saved on this device only.
              </p>
              <div
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Pressure clip"
              >
                {PRESSURE_CLIP_STEPS.map((percent) => (
                  <button
                    key={percent}
                    type="button"
                    role="radio"
                    aria-checked={pressureClipToPercent(pressureClip) === percent}
                    className={
                      pressureClipToPercent(pressureClip) === percent
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setPressureClip(pressureClipFromPercent(percent))}
                  >
                    <strong>{percent}%</strong>
                  </button>
                ))}
              </div>

              <div className="lc-settings-subhead">Speed ink</div>
              <p className="lc-settings-hint">
                Let the pace of your hand change what the nib leaves behind — ink pools
                where you dwell and thins out where you run, the way it does on paper.
                Off leaves the stroke the same weight however fast you write. Saved on
                this device only.
              </p>
              <div className="lc-settings-slider">
                <input
                  type="range"
                  className="lc-settings-slider-input"
                  min={0}
                  max={100}
                  step={5}
                  value={speedInkToPercent(inkSpeed)}
                  aria-label="Speed ink"
                  onChange={(event) =>
                    setInkSpeed(speedInkFromPercent(Number(event.target.value)))
                  }
                />
                <span className="lc-settings-slider-value">
                  {speedInkToPercent(inkSpeed) === 0 ? "Off" : `${speedInkToPercent(inkSpeed)}%`}
                </span>
              </div>

              <div className="lc-settings-subhead">Stroke smoothing</div>
              <p className="lc-settings-hint">
                How much of the shake to take out of a pen stroke. Higher steadies a
                shaky hand; lower keeps every kink you actually drew. Saved on this
                device only.
              </p>
              <div className="lc-settings-slider">
                <input
                  type="range"
                  className="lc-settings-slider-input"
                  min={0}
                  max={100}
                  step={5}
                  value={smoothingToPercent(inkSmoothing)}
                  aria-label="Stroke smoothing"
                  onChange={(event) =>
                    setInkSmoothing(smoothingFromPercent(Number(event.target.value)))
                  }
                />
                <span className="lc-settings-slider-value">
                  {smoothingToPercent(inkSmoothing) === 0
                    ? "Off"
                    : `${smoothingToPercent(inkSmoothing)}%`}
                </span>
              </div>

              {smoothingToPercent(inkSmoothing) > 0 && (
                <>
                  <p className="lc-settings-hint">
                    When it is applied. <strong>On the lift</strong> tidies the stroke once
                    you finish it, so the ink is always exactly under the nib as you write.
                    <strong> While you write</strong> smooths as it goes, which looks
                    steadier in the moment but leaves the ink trailing your hand — it stays
                    within about a nib of the pen, and loops no longer close from
                    over-smoothing alone.
                  </p>
                  <div
                    className="lc-settings-choice lc-settings-choice-compact"
                    role="radiogroup"
                    aria-label="When to smooth"
                  >
                    {(
                      [
                        ["lift", "On the lift"],
                        ["live", "While you write"],
                      ] as Array<[InkSmoothingMode, string]>
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={inkSmoothingMode === mode}
                        className={
                          inkSmoothingMode === mode
                            ? "lc-settings-choice-option is-active"
                            : "lc-settings-choice-option"
                        }
                        onClick={() => setInkSmoothingMode(mode)}
                      >
                        <strong>{label}</strong>
                      </button>
                    ))}
                  </div>
                </>
              )}

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
                <code>lc test</code>. Running every case is what lets the coach pick a real
                counterexample, so leave it on unless a run is slow.
              </p>

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
            </div>
          )}

          {tab === "server" && (
            <div className="lc-settings-fields">
              <div className="lc-settings-callout" role="note">
                <strong>localhost means the server, not this app</strong>
                <p>
                  {mobile ? "This tablet" : "The whiteboard"} talks to <code>lc serve</code> over
                  the network. The daemon on your PC then calls the LLM URL below.
                </p>
                <p>
                  <code>localhost</code> / <code>127.0.0.1</code> always mean{" "}
                  <strong>the machine running lc serve</strong>
                  {mobile ? ", not the tablet" : ""}. You do not point the tablet at Ollama
                  directly.
                </p>
              </div>

              <div className="lc-settings-subhead">Offline problems</div>
              <p className="lc-settings-hint">
                Download every indexed dataset except KodCode onto this device (~100–250&nbsp;MB).
                Browse and open statements offline; tests need the server.
              </p>
              {packMeta && (
                <p className="lc-muted">
                  On device: {packMeta.problemCount.toLocaleString()} problems · built{" "}
                  {new Date(packMeta.built_at * 1000).toLocaleString()}
                </p>
              )}
              {packInfo && <p className="lc-muted">{packInfo}</p>}
              {packError && <div className="lc-warning">{packError}</div>}
              <HoldButton
                label={packLabel}
                className={[
                  "lc-pack-download",
                  "lc-progress-fill",
                  packActive ? "lc-hold-danger" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                trackProgress={packActive ? packProgress : 0}
                fillIndeterminate={packBusy && packIndeterminate}
                disabled={Boolean(busy)}
                onTap={onPackTap}
                onConfirm={onPackAbort}
                ariaLabel={
                  packActive
                    ? `${packLabel}: tap to pause, hold to abort`
                    : packMeta
                      ? `${packLabel}: tap to delta refresh`
                      : packLabel
                }
              >
                {packLabel}
              </HoldButton>
              <p className="lc-settings-hint">
                {packActive
                  ? "Tap to pause · hold to abort (keeps the finished pack on device)."
                  : packMode === "delta"
                    ? "Refresh only fetches changed datasets and problems — unchanged corpora stay on device."
                    : "Downloads in the background — you can close Settings. Closing the app pauses; reopening resumes."}
              </p>

              <div className="lc-settings-subhead">Coach status</div>
              <p className="lc-coach-live" data-status={coachStatus}>
                <span className="lc-coach-live-dot" aria-hidden />
                <span>
                  {coachStatus === "online"
                    ? "Coach LLM online"
                    : coachStatus === "offline"
                      ? "Coach LLM offline"
                      : "Coach LLM status unknown"}
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
                {(["local", "ollama", "openai"] as const).map((p) => (
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
                    {p === "local" ? "Local" : p === "ollama" ? "Ollama" : "OpenAI"}
                  </button>
                ))}
              </div>

              <label>
                <span>LLM server URL (on the lc serve machine)</span>
                <input
                  value={provider.base_url}
                  onChange={(e) => patchProvider(providerFocus, { base_url: e.target.value })}
                  placeholder={
                    providerFocus === "openai"
                      ? "https://api.openai.com/v1"
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

              {providerFocus === "openai" && (
                <p className="lc-muted">API key from OPENAI_API_KEY env — not stored in config.toml.</p>
              )}

              <div className="lc-settings-subhead">Coach behaviour</div>
              <p className="lc-settings-hint">
                Frontier plans the approaches; local executes. The planner and the drawn-diagram
                check each cost an extra model call, so both start off.
              </p>
              {COACH_FLAGS.map(([key, label, hint]) => (
                <label key={key} className="lc-settings-toggle">
                  <input
                    type="checkbox"
                    checked={(draft.coach ?? DEFAULT_COACH_FLAGS)[key]}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        coach: {
                          ...DEFAULT_COACH_FLAGS,
                          ...(prev.coach ?? {}),
                          [key]: e.target.checked,
                        },
                      }))
                    }
                  />
                  <span>
                    <strong>{label}</strong>
                    <span className="lc-muted">{hint}</span>
                  </span>
                </label>
              ))}

              <div className="lc-settings-subhead">Coach mode providers</div>
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

              <div className="lc-settings-subhead">Local LLM process (on the PC)</div>
              <p className="lc-settings-hint">
                Starts or stops the bundled local model on the machine running{" "}
                <code>lc serve</code> — not on {mobile ? "the tablet" : "a remote client"}.
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

              <div className="lc-settings-subhead">Serve</div>
              <label>
                <span>Port</span>
                <input
                  type="number"
                  value={draft.serve_port}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      serve_port: Number(e.target.value) || prev.serve_port,
                    }))
                  }
                />
              </label>
              <p className="lc-muted">
                Pairing token:{" "}
                {draft.token_set ? "set (use lc serve --lan to rotate)" : "not set (loopback only)"}
              </p>

              <div className="lc-settings-subhead">Pair a tablet</div>
              {pairInfo?.code ? (
                <>
                  <dl className="lc-pair-readout">
                    <div>
                      <dt>Host</dt>
                      <dd>{pairInfo.host ?? "this machine's LAN address"}</dd>
                    </div>
                    <div>
                      <dt>Port</dt>
                      <dd>{pairInfo.port}</dd>
                    </div>
                    <div>
                      <dt>Code</dt>
                      <dd className="lc-pair-code">{pairInfo.code}</dd>
                    </div>
                  </dl>
                  <p className="lc-muted">
                    Type these three into the tablet's header. The code changes every time{" "}
                    <code>lc serve --lan</code> restarts; devices already paired keep working.
                  </p>
                </>
              ) : (
                <p className="lc-muted">
                  No pairing code — this daemon is loopback-only. Restart it with{" "}
                  <code>lc serve --lan</code> to pair a tablet.
                </p>
              )}
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
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
