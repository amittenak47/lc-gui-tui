/**
 * Settings modal — edits the shared `config.toml` via the in-process router.
 * Backdrop blurs the board the same way problem-load transitions do.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { checkPadHub, type PadHubCheck } from "../api/client";
import type { DevicePrefsDto, DlcStatus, LcClient } from "../api/client";
import type {
  CoachFlags,
  DatasetInfo,
  LcConfig,
  LcConfigPut,
  LlmStatus,
  ModelCatalog,
  ModelEntry,
  ProviderConfig,
} from "../api/types";
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
  AUTOSAVE_BANNER_CHOICES,
  AUTOSAVE_CHOICES,
  AUTOSAVE_EVENT,
  loadAutosaveBanner,
  loadAutosaveInterval,
  saveAutosaveBanner,
  saveAutosaveInterval,
  type AutosaveBanner,
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
import { auditDocBytes, clearDocBytes, inspectDocStore } from "../util/docBytes";
import {
  deviceRole,
  ensureDevicePrefs,
  loadDeviceId,
  saveThisDevicePrefs,
} from "../util/devicePrefs";
import { FEATURE_LEETCODE } from "../featureFlags";
import { loadPadHub, savePadHub } from "../util/padHub";

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

/**
 * What the model list is offering, and why it might be short.
 *
 * A provider that will not list its models is ordinary — OpenAI and Groq want
 * a key before they answer, and a local server that is not running answers
 * nothing at all — so this reads as information, never as an error.
 */
function modelHint(
  catalog: ModelCatalog | null,
  busy: boolean,
  typed: string,
  selected: ModelEntry | undefined,
): string {
  if (busy) return "Reading the model list…";
  if (!catalog) return "Could not read a model list. Type the model id by hand.";

  const onServer = catalog.models.filter((entry) => entry.source === "server").length;
  const onDisk = catalog.models.length - onServer;
  const found: string[] = [];
  if (onServer > 0) found.push(`${onServer} from the server`);
  if (onDisk > 0) found.push(`${onDisk} in the models folder`);

  const lines: string[] = [];
  if (found.length > 0) lines.push(`${found.join(", ")}.`);
  // A typed id the server has never heard of is the failure worth catching
  // here rather than on the first Review, where it arrives as a bare 404.
  if (typed.length > 0 && selected === undefined && onServer > 0) {
    lines.push(`The server did not list “${typed}”, so a chat call may fail.`);
  }
  if (catalog.notes[0]) lines.push(catalog.notes[0]);
  return lines.join(" ") || "No models listed — type the id by hand.";
}

/**
 * What is actually known about images for the chosen model — and nothing more.
 *
 * Only a server that says `multimodal` counts as a yes. A projector file beside
 * the weights is reported as what it is: evidence the model *can*, not proof
 * the server was launched to. Everything else says plainly that nothing was
 * reported, because the alternative is guessing from the name, and a wrong
 * guess sends every Draw request a PNG the endpoint will refuse.
 */
function visionEvidence(
  catalog: ModelCatalog | null,
  selected: ModelEntry | undefined,
  /** What the reader has answered, not what the server advertises. */
  ticked: boolean,
): string {
  if (!catalog || !selected) {
    return ticked
      ? "Images will be sent. Nothing was read back about this endpoint, so this is your call."
      : "Nothing was read back about this endpoint. Answer Yes if you know it takes images.";
  }
  if (selected.advertises_vision === true) {
    return ticked
      ? "The server reports this model accepts images. ✓"
      : "The server reports this model accepts images — answer Yes to let Draw and board review use them.";
  }
  if (selected.has_mmproj) {
    return ticked
      ? "A projector file (mmproj) sits beside these weights, so images should work if the server was started with it."
      : "A projector file (mmproj) sits beside these weights, so this model can read images if the server was started with it. The server does not advertise it, so this one is your call.";
  }
  return ticked
    ? "This endpoint does not report image support. Images will still be sent — answer No if Draw starts failing."
    : "This endpoint does not report image support. That is not the same as “no”: OpenAI and Groq never say. Answer Yes only if you know the model reads images.";
}

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

function formatDlcBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function emptyProvider(): ProviderConfig {
  return {
    base_url: "",
    model: "",
    vision_model: "",
    vision: null,
    embed_model: "",
    embed_base_url: "",
  };
}

function emptyConfig(): LcConfig {
  return {
    data_json_dir: null,
    dataset_dirs: {},
    workspace_dir: "~/lc-workspace",
    stop_on_first_failure: false,
    default_provider: "local",
    models_dir: "",
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
    serve_token: null,
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
  /** Whether a successful autosave raises the chrome banner. */
  autosaveBanner: AutosaveBanner;
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
    autosaveBanner: loadAutosaveBanner(),
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
    a.autosaveBanner === b.autosaveBanner &&
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

/**
 * Say which half of the pairing is wrong.
 *
 * The address and the code fail in the same place and used to read the same
 * way, so a tablet that could not sync gave no clue whether to check the Wi-Fi
 * or check six digits.
 */
function padHubProblem(result: Extract<PadHubCheck, { ok: false }>): string {
  if (result.reason === "code") {
    return "The PC refused this code. Read the 6-digit code off Settings → Pad hub on the desktop.";
  }
  return `Nothing answered (${result.detail}). Check the URL, and that both devices are on the same Wi-Fi.`;
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
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
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
  /*
   * The document-copy sweep, and its answer.
   *
   * "Clear all" is armed by a first tap rather than a confirm dialog: it is the
   * destructive one of the three, and every other hold-to-confirm control in
   * this app works the same way.
   */
  const [docCache, setDocCache] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "done"; message: string } | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const [docCacheArmed, setDocCacheArmed] = useState(false);

  const runDocCache = useCallback(
    async (action: "check" | "repair" | "clear" | "inspect") => {
      if (action === "inspect") {
        setDocCacheArmed(false);
        setDocCache({ kind: "busy" });
        try {
          const report = await inspectDocStore();
          const filled = report.stores
            .filter((row) => row.rows > 0)
            .map((row) => `${row.name} ${row.rows}`)
            .join(", ");
          setDocCache({
            kind: report.writeFailure ? "failed" : "done",
            message: [
              `${report.db} v${report.version}.`,
              `Document copies: ${report.rows} (${formatBytes(report.bytes)}).`,
              filled ? `Other stores: ${filled}.` : "Every store is empty.",
              report.wanted === 0
                ? "No PDFs or EPUBs in the library."
                : report.missing === 0
                  ? `All ${report.wanted} of the library's documents have their bytes.`
                  : `${report.missing} of ${report.wanted} library documents have no stored copy${
                      report.missingNames.length
                        ? ` (${report.missingNames.join(", ")}${report.missing > report.missingNames.length ? ", …" : ""})`
                        : ""
                    }.`,
              report.writeFailure
                ? `This device cannot save a document: ${report.writeFailure}`
                : "A 64 KB test write saved and read back correctly, so saving works.",
              report.missing > 0 && !report.writeFailure
                ? "Saving works, so these arrived by sync without their bytes — pick each one from Files once to restore it."
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          });
        } catch (cause) {
          setDocCache({
            kind: "failed",
            message: `The document store could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
        }
        return;
      }
      if (action === "clear" && !docCacheArmed) {
        setDocCacheArmed(true);
        setDocCache({
          kind: "done",
          message:
            "This drops every stored copy — each document has to be picked once more. Tap again to confirm.",
        });
        return;
      }
      setDocCacheArmed(false);
      setDocCache({ kind: "busy" });
      try {
        const audit =
          action === "clear"
            ? await clearDocBytes()
            : await auditDocBytes({ repair: action === "repair" });
        const held = `${audit.rows} ${audit.rows === 1 ? "copy" : "copies"}`;
        if (action === "clear") {
          setDocCache({
            kind: "done",
            message: `Cleared ${held}, freeing ${formatBytes(audit.freed)}. Pick each document again to bring it back.`,
          });
        } else if (audit.rows === 0) {
          // Not the same as healthy. An empty store on a device that has opened
          // documents means saving them is failing, and no repair touches that.
          setDocCache({
            kind: "failed",
            message:
              "No stored copies at all. If you have opened documents on this device, saving them is failing — run Diagnose.",
          });
        } else if (audit.bad === 0) {
          setDocCache({
            kind: "done",
            message: `${held} checked, all of them intact.`,
          });
        } else if (action === "repair") {
          setDocCache({
            kind: "done",
            message: `Dropped ${audit.removed} bad ${audit.removed === 1 ? "copy" : "copies"} of ${held}, freeing ${formatBytes(audit.freed)}. Pick those documents again — the rest are untouched.`,
          });
        } else {
          setDocCache({
            kind: "done",
            message: `${audit.bad} of ${held} no longer match the document they are filed under. Repair drops just those.`,
          });
        }
        // The bar above is now stale — re-read it rather than leave a number
        // that contradicts what this just reported.
        const usage = await estimateStorage().catch(() => null);
        if (usage) {
          setStorage((prev) => ({ ...usage, persisted: prev?.persisted ?? false }));
        }
      } catch (cause) {
        setDocCache({
          kind: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [docCacheArmed],
  );
  const [siblingDevices, setSiblingDevices] = useState<DevicePrefsDto[]>([]);
  const [hubUrl, setHubUrl] = useState("");
  const [hubToken, setHubToken] = useState("");
  const [baselineHubUrl, setBaselineHubUrl] = useState("");
  const [baselineHubToken, setBaselineHubToken] = useState("");
  const [hubCheck, setHubCheck] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "ok"; message: string }
    | { kind: "bad"; message: string }
  >({ kind: "idle" });
  /** This PC's address on the LAN — the thing a tablet has to be told. */
  const [lanUrl, setLanUrl] = useState<string | null>(null);
  const [bootNotice, setBootNotice] = useState<string | null>(null);
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
  const [autosaveBanner, setAutosaveBanner] = useState<AutosaveBanner>(() =>
    loadAutosaveBanner(),
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

  /**
   * What the focused provider could be pointed at. Read-only: it fills the
   * model list and reports what the server says about images, but the vision
   * flag stays the reader's to tick — a name is not a capability.
   */
  const refreshCatalog = useCallback(
    async (provider: string) => {
      setCatalogBusy(true);
      try {
        setCatalog(await client.listModels(provider));
      } catch {
        setCatalog(null);
      } finally {
        setCatalogBusy(false);
      }
    },
    [client],
  );

  // The list is per provider, so a tab switch invalidates it. Clearing first
  // stops the previous provider's models being offered for this one.
  useEffect(() => {
    if (tab !== "llm") return;
    setCatalog(null);
    void refreshCatalog(providerFocus);
  }, [tab, providerFocus, refreshCatalog]);

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
      const rows = await client.dlcStatus();
      setDlcRows(Array.isArray(rows) ? rows : []);
    } catch {
      setDlcRows([]);
    }
    try {
      setDatasets(await client.datasets());
    } catch {
      /* older daemon has no /datasets */
    }
  }, [client]);

  useEffect(() => {
    if (!open || tab !== "workspace") return;
    void refreshDlc();
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<DlcStatus[]>("lc-dlc-status", (event) => {
          if (!Array.isArray(event.payload)) return;
          setDlcRows(event.payload);
          setDatasets((current) =>
            current.map((entry) => {
              const row = event.payload.find((item) => item.slug === entry.id);
              return row ? { ...entry, count: row.count } : entry;
            }),
          );
        }),
      )
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => {
        /* browser preview has no Tauri event bus */
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
        if (!row?.slug) return;
        setDlcRows((current) =>
          (Array.isArray(current) ? current : []).map((entry) =>
            entry.slug === slug ? row : entry,
          ),
        );
      }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [client],
  );

  const onDlcRemove = useCallback(
    (slug: string) => {
      void client.dlcRemove(slug).then((row) => {
        if (!row?.slug) return;
        setDlcRows((current) =>
          (Array.isArray(current) ? current : []).map((entry) =>
            entry.slug === slug ? row : entry,
          ),
        );
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
    setAutosaveBanner(prefs.autosaveBanner);
    setPaletteTag(prefs.paletteTag);
    setColorWheelOnToolbar(prefs.colorWheelOnToolbar);
    setTapOk(prefs.tapOk);
    setChromeWake(prefs.chromeWake);
    setChromeWakeTint(prefs.chromeWakeTint);
    setBaselinePrefs(prefs);
    const hub = loadPadHub();
    setHubUrl(hub?.url ?? "");
    setHubToken(hub?.token ?? "");
    setBaselineHubUrl(hub?.url ?? "");
    setBaselineHubToken(hub?.token ?? "");
    setHubCheck({ kind: "idle" });
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
          const url = await client.lanBaseUrl(cfg.serve_port);
          if (!cancelled) setLanUrl(url);
        }
        await refreshLlm();
        try {
          const notice = await client.bootNotice();
          if (!cancelled) setBootNotice(notice);
        } catch {
          if (!cancelled) setBootNotice(null);
        }
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
    autosaveBanner,
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
    !configEqual(draft, baselineConfig) ||
    !prefsEqual(draftPrefs, baselinePrefs) ||
    keysDirty ||
    hubUrl.trim() !== baselineHubUrl ||
    hubToken.trim() !== baselineHubToken;

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
        saveAutosaveBanner(autosaveBanner);
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
      const hubDirty =
        hubUrl.trim() !== baselineHubUrl || hubToken.trim() !== baselineHubToken;
      if (hubDirty) {
        const url = hubUrl.trim();
        const token = hubToken.trim();
        if (Boolean(url) !== Boolean(token) || (token && !/^\d{6}$/.test(token))) {
          throw new Error("Pad hub needs both the PC URL and the 6-digit code.");
        }
        savePadHub(url && token ? { url, token } : null);
        setBaselineHubUrl(url);
        setBaselineHubToken(token);
        if (url && token) {
          // Store first, then ask. Saving a pair that turns out not to work is
          // still worth keeping — the reader is one digit away from a fix and
          // should not have to retype the address to try it. But it must not
          // pass in silence: a hub that was never reached looks exactly like a
          // hub that was, until the day a file fails to arrive.
          const result = await runHubCheck({ url, token });
          if (!result.ok) throw new Error(`Saved, but not connected. ${padHubProblem(result)}`);
        } else {
          setHubCheck({ kind: "idle" });
        }
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

  const runHubCheck = async (hub: { url: string; token: string }): Promise<PadHubCheck> => {
    setHubCheck({ kind: "busy" });
    const result = await checkPadHub(hub);
    setHubCheck(
      result.ok
        ? {
            kind: "ok",
            message: result.version
              ? `Connected — this PC is running whiteboard ${result.version}.`
              : "Connected.",
          }
        : { kind: "bad", message: padHubProblem(result) },
    );
    return result;
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
  const selectedModel = catalog?.models.find((entry) => entry.id === provider.model.trim());
  const modelListHint = modelHint(catalog, catalogBusy, provider.model.trim(), selectedModel);
  const visionHint = visionEvidence(catalog, selectedModel, provider.vision === true);
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
          {bootNotice && (
            <div className="lc-warning">
              Running on built-in defaults — this device’s config file did not
              load ({bootNotice}). Saving here writes the defaults over it.
            </div>
          )}
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
              <div className="lc-settings-subhead">Corpora (DLC)</div>
              <p className="lc-settings-hint">
                Nothing ships in the APK. Install a set to download its jsonl zip
                (GitHub release <code>corpora-v1</code>), unpack, and index. Off
                until you install. KodCode is large (~1 GB). Pass/fail badges stay
                in <code>session.json</code> if you Remove and later reinstall.
              </p>
              {(Array.isArray(dlcRows) ? dlcRows : []).map((row) => {
                const working = ["downloading", "unpacking", "indexing"].includes(row.phase);
                const pct = row.progress >= 0 ? Math.round(row.progress * 100) : null;
                const downloaded = row.downloaded ?? 0;
                const total = row.total ?? 0;
                const label = working
                  ? row.phase === "downloading" && pct != null
                    ? `${pct}%`
                    : "…"
                  : row.installed
                    ? "Remove"
                    : "Install";
                const countLabel =
                  row.phase === "downloading" && total > 0
                    ? `${formatDlcBytes(downloaded)} / ${formatDlcBytes(total)}`
                    : `${row.count.toLocaleString()} indexed`;
                const fillPct =
                  working && pct != null ? `${pct}%` : working ? "40%" : "0%";
                return (
                  <div key={row.slug} className="lc-settings-dlc-row">
                    <span className="lc-settings-dlc-name">{row.label}</span>
                    <span className="lc-settings-dlc-count">{countLabel}</span>
                    <button
                      type="button"
                      className={[
                        "lc-settings-dlc-action",
                        row.installed && !working ? "is-remove" : "",
                        working ? "is-busy" : "",
                        working && pct == null ? "is-indeterminate" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ "--dlc-progress": fillPct } as CSSProperties}
                      disabled={Boolean(busy) || working}
                      onClick={() =>
                        row.installed && !working
                          ? onDlcRemove(row.slug)
                          : onDlcInstall(row.slug)
                      }
                    >
                      <span>{label}</span>
                    </button>
                    {row.error && <p className="lc-warning lc-settings-dlc-error">{row.error}</p>}
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
                    value={draft.dataset_dirs?.[entry.id] ?? ""}
                    placeholder={entry.corpus_dir ?? `<problems folder>/${entry.id}`}
                    onChange={(e) =>
                      setDraft((prev) => {
                        const dirs = { ...(prev.dataset_dirs ?? {}) };
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
              <div className="lc-settings-subhead">Pad hub</div>
              <p className="lc-settings-hint">
                A tablet pings this PC on the LAN and pulls every saved file that
                changed: whiteboards, annotated documents, rolling snapshots, and
                PDF/EPUB bytes. Ink pages stay on the device that drew them.
              </p>
              {draft.serve_token ? (
                <>
                  <p className="lc-settings-hint">
                    This PC is the hub. Type both of these into Settings → Pad hub
                    on the tablet.
                  </p>
                  <dl className="lc-pad-hub-card">
                    <div>
                      <dt>PC URL</dt>
                      <dd>
                        {lanUrl ? (
                          <code className="lc-pad-hub-url">{lanUrl}</code>
                        ) : (
                          <span className="lc-muted">
                            this PC’s address on the network, port {draft.serve_port}
                          </span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>6-digit code</dt>
                      <dd>
                        <code className="lc-pad-hub-code">{draft.serve_token}</code>
                      </dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="lc-settings-hint">
                  Open Settings on the desktop app to see the URL and 6-digit code.
                </p>
              )}
              <label className="lc-md-new-title">
                <span className="lc-muted">Connect to a PC — URL</span>
                <input
                  type="url"
                  value={hubUrl}
                  /*
                   * Spelled as an example, because it did not used to be.
                   * A bare address here reads as a value already filled in —
                   * so the code went in, the URL stayed empty, and Save
                   * answered with a complaint about a field that looked full.
                   */
                  placeholder="e.g. http://192.168.1.10:7878"
                  onChange={(event) => {
                    setHubUrl(event.target.value);
                    setHubCheck({ kind: "idle" });
                  }}
                />
              </label>
              <label className="lc-md-new-title">
                <span className="lc-muted">6-digit code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={6}
                  pattern="[0-9]{6}"
                  placeholder="e.g. 000000"
                  value={hubToken}
                  onChange={(event) => {
                    setHubToken(event.target.value.replace(/\D/g, "").slice(0, 6));
                    setHubCheck({ kind: "idle" });
                  }}
                />
              </label>
              <div className="lc-pad-hub-check">
                <button
                  type="button"
                  className="lc-secondary"
                  disabled={
                    hubCheck.kind === "busy" ||
                    !hubUrl.trim() ||
                    !/^\d{6}$/.test(hubToken.trim())
                  }
                  onClick={() => {
                    void runHubCheck({ url: hubUrl.trim(), token: hubToken.trim() });
                  }}
                >
                  {hubCheck.kind === "busy" ? "Checking…" : "Check connection"}
                </button>
                {hubCheck.kind === "ok" && (
                  <p className="lc-pad-hub-verdict is-ok">{hubCheck.message}</p>
                )}
                {hubCheck.kind === "bad" && (
                  <p className="lc-pad-hub-verdict is-bad">{hubCheck.message}</p>
                )}
              </div>
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
              <p className="lc-settings-hint">
                The write is independent of the banner. Parked tabs still save;
                they just do not flash Saved over the pad you are looking at.
              </p>
              <div
                className="lc-settings-choice"
                role="radiogroup"
                aria-label="Autosave banners"
              >
                {AUTOSAVE_BANNER_CHOICES.map(([id, label, hint]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={autosaveBanner === id}
                    className={
                      autosaveBanner === id
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setAutosaveBanner(id)}
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

              <div className="lc-settings-subhead">Stored document copies</div>
              <p className="lc-settings-hint">
                The app keeps its own copy of every PDF and EPUB you have opened, filed
                under a fingerprint of the file’s contents. <strong>Check copies</strong>{" "}
                re-reads each one and reports any that no longer match the file they are
                filed under — a stale copy is what makes a document that opens fine in
                Files refuse to open here. Repairing drops only those; the originals in
                Files are untouched and your annotations stay in the library, so a
                repaired document just has to be picked once more.
              </p>
              <div className="lc-pad-hub-check">
                <button
                  type="button"
                  className="lc-secondary"
                  disabled={docCache.kind === "busy"}
                  onClick={() => {
                    void runDocCache("check");
                  }}
                >
                  {docCache.kind === "busy" ? "Working…" : "Check copies"}
                </button>
                <button
                  type="button"
                  className="lc-secondary"
                  disabled={docCache.kind === "busy"}
                  onClick={() => {
                    void runDocCache("inspect");
                  }}
                >
                  Diagnose
                </button>
                <button
                  type="button"
                  className="lc-secondary"
                  disabled={docCache.kind === "busy"}
                  onClick={() => {
                    void runDocCache("repair");
                  }}
                >
                  Repair
                </button>
                <button
                  type="button"
                  className="lc-secondary"
                  disabled={docCache.kind === "busy"}
                  onClick={() => {
                    void runDocCache("clear");
                  }}
                >
                  {docCacheArmed ? "Tap again to clear all" : "Clear all"}
                </button>
              </div>
              {docCache.kind === "done" && (
                <p className="lc-muted">{docCache.message}</p>
              )}
              {docCache.kind === "failed" && (
                <p className="lc-settings-error">{docCache.message}</p>
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
              {(providerFocus === "local" || providerFocus === "ollama") && (
                <label>
                  <span>Models folder</span>
                  <input
                    value={draft.models_dir}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, models_dir: e.target.value }))
                    }
                    placeholder="C:\Users\you\Models"
                  />
                  <p className="lc-settings-hint">
                    Optional. A folder of downloaded weights — one subfolder per model, or a
                    flat pile of <code>.gguf</code> — offered in the list below even while the
                    server is down. Save, then Refresh models.
                  </p>
                </label>
              )}
              <label>
                <span>Chat model</span>
                <input
                  list="lc-model-options"
                  value={provider.model}
                  onChange={(e) => patchProvider(providerFocus, { model: e.target.value })}
                />
                <datalist id="lc-model-options">
                  {(catalog?.models ?? []).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.source === "disk" ? "on disk" : "on the server"}
                    </option>
                  ))}
                </datalist>
                <p className="lc-settings-hint">{modelListHint}</p>
              </label>
              <div className="lc-settings-actions-row">
                <button
                  type="button"
                  className="lc-secondary"
                  disabled={catalogBusy}
                  onClick={() => void refreshCatalog(providerFocus)}
                >
                  {catalogBusy ? "Reading…" : "Refresh models"}
                </button>
              </div>
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
                  Optional other model id for PNG requests. Leave empty to reuse the chat model.
                  Tick Accepts images or Draw will not send pictures — the name is not a
                  capability check.
                </p>
              </label>
              {/*
                Embeddings, for the document index.
                
                Local-only: the index is a local SQLite file beside the corpus,
                and shipping every page of every document to a hosted embedding
                endpoint is not a decision to make quietly in a settings row.
              */}
              {providerFocus === "local" && (
                <>
                  <label>
                    <span>Embedding model</span>
                    <input
                      value={provider.embed_model ?? ""}
                      onChange={(e) =>
                        patchProvider(providerFocus, { embed_model: e.target.value })
                      }
                      list="lc-model-options"
                      placeholder="(none — match on words)"
                    />
                    <p className="lc-settings-hint">
                      What Ask searches your documents with. Empty means chunks are
                      matched on the words they share with your question rather than
                      what it means — so “which record wins” will not find “the master
                      data is never copied”. <code>nomic-embed-text</code> is small
                      enough to sit beside the chat model. Documents already indexed
                      keep their old vectors until you re-index them from the chip in
                      the tab strip.
                    </p>
                  </label>
                  <label>
                    <span>Embedding endpoint</span>
                    <input
                      value={provider.embed_base_url ?? ""}
                      onChange={(e) =>
                        patchProvider(providerFocus, { embed_base_url: e.target.value })
                      }
                      placeholder="(same as base URL)"
                    />
                    <p className="lc-settings-hint">
                      Optional OpenAI-compatible <code>/embeddings</code> base. Leave
                      empty to reuse the base URL above.
                    </p>
                  </label>
                </>
              )}

              <div className="lc-settings-subhead">Accepts images</div>
              <div
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Accepts images"
              >
                {([
                  [true, "Yes"],
                  [false, "No"],
                ] as const).map(([value, label]) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={(provider.vision === true) === value}
                    className={
                      (provider.vision === true) === value
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => patchProvider(providerFocus, { vision: value })}
                  >
                    <strong>{label}</strong>
                  </button>
                ))}
              </div>
              <p className="lc-settings-hint">{visionHint}</p>

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
