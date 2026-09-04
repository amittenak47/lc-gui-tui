/**
 * The app shell: the part that outlives any one workspace.
 *
 * Everything here is true whichever tab is on screen — the daemon client, the
 * theme, the pen's prefs, the LLM's health, the boot overlay, and the strip
 * itself, which must not remount when you switch or it would lose its scroll
 * and its focus ring mid-tap.
 *
 * The workspace is `Workspace.tsx`, mounted under `key={tab.id}`. That key is
 * the whole isolation story: two tabs cannot bleed into each other because
 * they are two instances. Opening is writing a record here; the workspace that
 * mounts for it is what loads.
 *
 * Home is a workspace too. It was never anything but an idle board with a
 * chooser over it, and treating it as one is what keeps the library dialogs,
 * the "open another" icons and the browse choreography in a single place —
 * they behave the same whether a pad is live or you are looking at the cards.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";

import { LcClient } from "./api/client";
import { isTauriRuntime } from "./api/nativeHttp";
import type { SearchOptions } from "./api/client";
import type { CoachCapabilities, CoachFlags, SessionSnapshot } from "./api/types";
import { DEFAULT_COACH_FLAGS } from "./api/types";
import { BrandHome } from "./components/BrandHome";
import { Tip } from "./components/Tip";
import { DocIndexChip } from "./components/DocIndexChip";
import { LoadingDoodle } from "./components/LoadingDoodle";
import { LlmStatusDialog } from "./components/LlmStatusDialog";
import { SettingsModal } from "./components/SettingsModal";
import { StatusBanner } from "./components/StatusBanner";
import { SmartTips } from "./components/SmartTips";
import { SplitFocusToast } from "./components/SplitFocusToast";
import { SplitSash } from "./components/SplitSash";
import { applyInkChromeScale } from "./util/chromeScale";
import { TabStrip } from "./components/TabStrip";
import { renameTabPad } from "./util/libraryPadRename";
import { MlKitRecognizer, NoopRecognizer, pickRecognizer, type InkRecognizer } from "./canvas/ink";
import { saveBoardReadingSize, type BoardReadingSize } from "./modes/codeFontSize";
import { loadPdfFilmPref } from "./modes/pdfFilm";
import { applyAppTheme, loadThemeId, saveThemeId } from "./theme/appThemes";
import {
  AUTOSAVE_EVENT,
  autosaveBannerAllowed,
  coalesceAutosaveNotice,
  loadAutosaveBanner,
  loadAutosaveInterval,
  type AutosaveInterval,
} from "./util/autosavePref";
import { AGENT_SHEET_LOCK_EVENT, loadAgentSheetLock } from "./util/agentSheetLockPref";
import { loadTestForwardMode, type TestForwardMode } from "./util/agentPrefs";
import { installHandednessAttr } from "./util/inkHandedness";
import { installSafeAreaInsets } from "./util/safeArea";
import { isAndroidDevice } from "./util/androidDevice";
import { useIsMobile } from "./util/mobile";
import {
  HOME_TAB_ID,
  activeTab as activeTabOf,
  groupOf,
  liveOverflow,
  openedRecord,
  pinLive,
  promoteLive,
  tabsReducer,
  visibleTabIds,
  type SplitEdge,
  type TabPatch,
  type TabRecord,
} from "./util/tabs";
import { loadTabState, saveTabState } from "./util/tabPersist";
import { isCameraBusy } from "./util/cameraBusy";
import { ensureDevicePrefs } from "./util/devicePrefs";
import {
  applyPadSyncPing,
  flushPadSyncQueue,
  pullPads,
  PAD_SYNC_PING_MS,
} from "./util/padSync";
import { HUB_AUTOSYNC_EVENT, loadHubAutosyncPref } from "./util/hubAutoSyncPref";
import { PAD_HUB_EVENT, setHostLoopback } from "./util/padHub";
import { deviceRole } from "./util/devicePrefs";
import { singleFlight } from "./util/singleFlight";
import { bumpRetry, planWorkspaceMounts, workspaceMountKey } from "./util/workspaceMounts";
import type { WebPadEntry } from "./util/webPadSession";
import { Workspace } from "./Workspace";
import {
  chromeLooksSame,
  NO_CHROME,
  ShellContext,
  type HeaderSlots,
  type ShellValue,
  type WorkspaceApi,
  type WorkspaceChrome,
} from "./shellContext";
import { messageOf } from "./util/messageOf";

/**
 * How many workspaces stay mounted at once.
 *
 * Excalidraw, pdf.js and Monaco cannot all stay up for ten tabs, so most
 * parked tabs are records and nothing else. Two is the floor worth paying
 * for: the one being looked at, and the one just left — which is the switch
 * people actually repeat, and the one that used to cost a full reload. Split
 * panes raise it, because both halves are being looked at. Home is outside
 * this budget: it is cheap to keep and expensive to remount, so it stays
 * mounted and never counts against the two.
 */
const LIVE_LIMIT = 2;

const LLM_ONLINE_POLL_MS = 20_000;
const LLM_OFFLINE_POLL_MS = 60_000;
const LLM_OFFLINE_POLL_MAX_MS = 120_000;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function doneHoldMs(): number {
  return prefersReducedMotion() ? 0 : 420;
}

function serverGateExitMs(): number {
  return prefersReducedMotion() ? 0 : 240;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}


/** Tauri's `invoke`, or null on plain web / `vite dev`. */
async function loadTauriInvoke() {
  try {
    const mod = await import("@tauri-apps/api/core");
    return mod.invoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  } catch {
    return null;
  }
}

export function App() {
  const mobile = useIsMobile();
  const android = isAndroidDevice();

  useEffect(() => installSafeAreaInsets(), []);

  // Writing hand mirrors the chrome across the Y-axis — see inkHandedness.
  useEffect(() => installHandednessAttr(), []);

  /** In-process daemon is assumed up; this flag still gates pad sync / tests. */
  const [serverLink] = useState<"checking" | "online" | "offline">("online");
  const serverLinkRef = useRef(serverLink);
  serverLinkRef.current = serverLink;
  const [bootPhase, setBootPhase] = useState<"enter" | "show" | "done" | "exit" | "gone">("enter");
  /** The boot overlay is still on screen, so nothing else may open in front of it. */
  const bootOverlayPendingRef = useRef(true);
  /** The LLM came back offline while the overlay was still up. Ask once it is gone. */
  const llmGateWantedRef = useRef(false);

  /** Something the reader should know, but which did not stop the request. */
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const client = useMemo(() => new LcClient(), []);

  /*
   * Pad auto-sync, once for the app.
   *
   * This used to run per workspace. `pullPads` lists and walks every pad,
   * snapshot, document chunk and IndexedDB record, so a split did all of it
   * twice on open and kept two fifteen-second ping timers alive afterwards —
   * and every remount paid for the whole bootstrap again. There is one library
   * and one hub behind all of it.
   *
   * Separate from the Sync pill, which is a manual walk with its own
   * conflict rules. This is the background last-writer-wins path.
   */
  const [hubAutosyncOn, setHubAutosyncOn] = useState(
    () => loadHubAutosyncPref() === "on",
  );
  /** Re-read on Save, so turning it off tears the timer down without a remount. */
  useEffect(() => {
    const onHubAutosync = () => setHubAutosyncOn(loadHubAutosyncPref() === "on");
    window.addEventListener(HUB_AUTOSYNC_EVENT, onHubAutosync);
    return () => window.removeEventListener(HUB_AUTOSYNC_EVENT, onHubAutosync);
  }, []);

  /*
   * Put this device on the hub as soon as there is a hub to put it on.
   *
   * `ensureDevicePrefs` runs once at boot, against whatever database the
   * device pointed at then — which for a tablet that had not paired yet was
   * its own. Pairing in Settings changed where every device call goes and
   * nothing re-registered, so the PC's roster never learned the tablet existed
   * and the tablet's list stayed a list of one.
   */
  useEffect(() => {
    if (serverLink !== "online") return;
    const onHub = () => {
      void ensureDevicePrefs(client).catch(() => {});
    };
    window.addEventListener(PAD_HUB_EVENT, onHub);
    return () => window.removeEventListener(PAD_HUB_EVENT, onHub);
  }, [client, serverLink]);

  /*
   * The desktop that *is* the hub gets a loopback hub of its own.
   *
   * Everything hub-shaped is gated on `loadPadHub()`, and the host leaves the
   * Connect fields empty on purpose — its card says "type these into the
   * tablet". So on the machine holding the library there was no Sync pill at
   * all, and `indexFromBytes`, which is hub-HTTP only, had nowhere to send a
   * document. Pointing the host at its own serve gives it the same walk the
   * tablet gets, against the very same `pads.db`.
   *
   * Desktop only. Android may still carry a serve token in some builds, and a
   * loopback there would have the tablet syncing with itself instead of the PC.
   * Never written to storage: this is a fact about the running process, not a
   * pairing anyone chose.
   */
  useEffect(() => {
    if (serverLink !== "online") return;
    if (deviceRole() !== "desktop") return;
    let cancelled = false;
    void (async () => {
      try {
        const config = await client.getConfig();
        if (cancelled) return;
        const token = config.serve_token?.trim();
        const port = config.serve_port;
        if (!token || !port) return;
        setHostLoopback({ url: `http://127.0.0.1:${port}`, token });
      } catch {
        /* no serve config — the host simply has no hub of its own */
      }
    })();
    return () => {
      cancelled = true;
      setHostLoopback(null);
    };
  }, [client, serverLink]);

  useEffect(() => {
    if (serverLink !== "online") return;
    let cancelled = false;
    void (async () => {
      try {
        if (hubAutosyncOn) {
          if (isCameraBusy()) return;
          await applyPadSyncPing(client).catch(() => {});
          if (cancelled || isCameraBusy()) return;
          await pullPads(client);
          if (cancelled) return;
          await flushPadSyncQueue(client);
          if (cancelled) return;
        }
        void ensureDevicePrefs(client).catch(() => {});
      } catch {
        /* daemon missing the new routes — keep the local cache */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverLink, client, hubAutosyncOn]);

  useEffect(() => {
    if (serverLink !== "online") return;
    // Off means off: no interval exists at all, so nothing can leak a ping.
    if (!hubAutosyncOn) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") return;
      if (isCameraBusy()) return;
      void applyPadSyncPing(client).catch(() => {});
    };
    const timer = window.setInterval(tick, PAD_SYNC_PING_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [serverLink, client, hubAutosyncOn]);
  const [recognizer, setRecognizer] = useState<InkRecognizer>(() => new NoopRecognizer());

  /*
   * The boot overlay runs its own beats and leaves.
   *
   * It used to hold at "show" until the LLM probe answered — two four-second
   * races, back to back — so a slow or absent daemon kept a splash over an app
   * that had finished loading and does not need an LLM to draw anything. The
   * probe still opens the LLM gate when it comes back offline; it now does that
   * behind the app rather than in front of it, and if it answers first the gate
   * waits for the overlay instead of the other way round.
   *
   * Overlay is opaque from the first paint (no fade-in). The rAF only advances
   * the phase machine; CSS must not start this overlay at opacity 0.
   */
  useEffect(() => {
    let cancelled = false;
    let exitTimer = 0;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      setBootPhase((phase) => (phase === "enter" ? "show" : phase));
      void (async () => {
        await waitMs(doneHoldMs());
        if (cancelled) return;
        setBootPhase("done");
        await waitMs(doneHoldMs());
        if (cancelled) return;
        setBootPhase("exit");
        exitTimer = window.setTimeout(() => {
          if (cancelled) return;
          setBootPhase("gone");
          bootOverlayPendingRef.current = false;
          if (llmGateWantedRef.current && !llmPromptedRef.current) {
            llmPromptedRef.current = true;
            openLlmGateRef.current();
          }
        }, serverGateExitMs());
      })();
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(exitTimer);
    };
  }, []);

  /*
   * Native "the seed finished" → a `window` event, once for the app.
   *
   * `ProblemBrowser` listens on `window`, and every mounted Workspace used to
   * install this bridge, so one native event arrived as two or three window
   * events. The old cleanup was `stop?.()`, which does nothing while `listen`
   * is still resolving — unmount during registration left the listener behind
   * for good.
   */
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      if (cancelled) return;
      void listen("lc-seed-ready", () => {
        window.dispatchEvent(new Event("lc-seed-ready"));
      }).then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
      });
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // ML Kit if we're on Android, otherwise typed text and the PNG fallback.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const tauriInvoke = await loadTauriInvoke();
      const candidates = tauriInvoke ? [new MlKitRecognizer(tauriInvoke)] : [];
      const picked = await pickRecognizer(candidates);
      if (!cancelled) setRecognizer(picked);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [llmLink, setLlmLink] = useState<"unknown" | "online" | "offline">("unknown");
  const [llmDetail, setLlmDetail] = useState<string | null>(null);
  const [llmGateOpen, setLlmGateOpen] = useState(false);
  const [llmGatePhase, setLlmGatePhase] = useState<"enter" | "open" | "exit">("enter");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<
    "paths" | "llm" | "serve" | "datasets" | "workspace" | "agent" | undefined
  >(undefined);
  const llmPromptedRef = useRef(false);

  const probeLlm = useCallback(async (): Promise<boolean> => {
    try {
      const cfg = await Promise.race([
        client.getConfig(),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("config timed out")), 4000);
        }),
      ]);
      const provider = cfg.default_provider;
      if (provider === "openai" || provider === "groq") {
        const detail = `${provider} (cloud)`;
        setLlmDetail((prev) => (prev === detail ? prev : detail));
        setLlmLink((prev) => (prev === "online" ? prev : "online"));
        return true;
      }
      const status = await Promise.race([
        client.llmStatus(),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("LLM status timed out")), 4000);
        }),
      ]);
      const online = /LLM reachable/i.test(status.detail ?? "");
      const detail = status.detail || null;
      setLlmDetail((prev) => (prev === detail ? prev : detail));
      setLlmLink((prev) => {
        const next = online ? "online" : "offline";
        return prev === next ? prev : next;
      });
      return online;
    } catch (cause) {
      const detail = messageOf(cause);
      setLlmDetail((prev) => (prev === detail ? prev : detail));
      setLlmLink((prev) => (prev === "offline" ? prev : "offline"));
      return false;
    }
  }, [client]);

  const openLlmGate = useCallback(() => {
    setLlmGatePhase("enter");
    setLlmGateOpen(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setLlmGatePhase("open"));
    });
  }, []);

  /*
   * The boot effect above runs before this is declared, and must not re-run
   * when it is: a dependency on `openLlmGate` would restart the overlay beats.
   */
  const openLlmGateRef = useRef(openLlmGate);
  openLlmGateRef.current = openLlmGate;

  const closeLlmGate = useCallback(() => {
    setLlmGatePhase("exit");
    window.setTimeout(() => setLlmGateOpen(false), serverGateExitMs());
  }, []);

  /*
   * Check whether a model is actually available for Coach.
   *
   * One probe at a time, one timer. Focus, `visibilitychange` and the poll
   * timer all want the same answer; each used to start its own request *and*
   * its own follow-up timer when that request came back, so two events close
   * together left two polling chains behind a single timer handle. Only the
   * newest could ever be cleared, and the rest kept asking `/config` and
   * `/llm/status` — and re-rendering — for the life of the session.
   *
   * Poll backs off hard while the LLM is offline so we do not hammer the
   * daemon when it has no model. Offline grows to two minutes; focus and
   * visibility still probe promptly.
   */
  useEffect(() => {
    if (serverLink !== "online") {
      setLlmLink("unknown");
      llmPromptedRef.current = false;
      return;
    }
    let cancelled = false;
    let timer = 0;
    let delayMs = LLM_ONLINE_POLL_MS;

    /** Overlapping callers share one request instead of starting three. */
    const probeOnce = singleFlight(probeLlm);

    const afterProbe = (ok: boolean) => {
      if (ok) {
        delayMs = LLM_ONLINE_POLL_MS;
        return;
      }
      delayMs =
        delayMs < LLM_OFFLINE_POLL_MS
          ? LLM_OFFLINE_POLL_MS
          : Math.min(Math.round(delayMs * 1.5), LLM_OFFLINE_POLL_MAX_MS);
    };

    /*
     * Ask about the missing model once, and never over the boot overlay —
     * the overlay is opaque, so a gate opened under it is a dialog nobody can
     * answer. The boot effect opens it on the way out instead.
     */
    const noteLlm = (ok: boolean) => {
      if (ok || llmPromptedRef.current) return;
      if (bootOverlayPendingRef.current) {
        llmGateWantedRef.current = true;
        return;
      }
      llmPromptedRef.current = true;
      openLlmGate();
    };

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), delayMs);
    };

    const tick = async () => {
      const ok = await probeOnce();
      if (cancelled) return;
      afterProbe(ok);
      noteLlm(ok);
      schedule();
    };

    void tick();

    const onFocus = () => {
      if (cancelled) return;
      delayMs = LLM_ONLINE_POLL_MS;
      void tick();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [serverLink, probeLlm, openLlmGate]);

  const [themeId, setThemeId] = useState(loadThemeId);
  const [readingSize, setReadingSize] = useState<BoardReadingSize>("M");
  const [autosaveMs, setAutosaveMs] = useState<AutosaveInterval>(() => loadAutosaveInterval());
  const [testForward, setTestForward] = useState<TestForwardMode>(() => loadTestForwardMode());
  const [sheetDragLocked, setSheetDragLocked] = useState(() => loadAgentSheetLock());
  const [pdfFilmOpen, setPdfFilmOpen] = useState(loadPdfFilmPref);

  useEffect(() => {
    applyAppTheme(themeId);
    saveThemeId(themeId);
  }, [themeId]);

  useEffect(() => {
    // S/M/L is gone — annotations track the page, and a size switch reflows
    // frames without remapping ink. Always Medium.
    if (readingSize !== "M") setReadingSize("M");
    saveBoardReadingSize("M");
  }, [readingSize]);

  useEffect(() => {
    const onAutosave = () => setAutosaveMs(loadAutosaveInterval());
    window.addEventListener(AUTOSAVE_EVENT, onAutosave);
    return () => window.removeEventListener(AUTOSAVE_EVENT, onAutosave);
  }, []);

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<TestForwardMode>).detail;
      setTestForward(
        next === "wait" || next === "whole-run" || next === "per-case"
          ? next
          : loadTestForwardMode(),
      );
    };
    window.addEventListener("lc-agent-test-forward", onChange);
    return () => window.removeEventListener("lc-agent-test-forward", onChange);
  }, []);

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail;
      setSheetDragLocked(typeof next === "boolean" ? next : loadAgentSheetLock());
    };
    window.addEventListener(AGENT_SHEET_LOCK_EVENT, onChange);
    return () => window.removeEventListener(AGENT_SHEET_LOCK_EVENT, onChange);
  }, []);

  const [capabilities, setCapabilities] = useState<CoachCapabilities | null>(null);
  const [coachFlags, setCoachFlags] = useState<CoachFlags>(DEFAULT_COACH_FLAGS);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const caps = await client.capabilities();
        if (!cancelled) setCapabilities(caps);
      } catch {
        if (!cancelled) setCapabilities(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const refreshCoachFlags = useCallback(async () => {
    try {
      const config = await client.getConfig();
      setCoachFlags({ ...DEFAULT_COACH_FLAGS, ...(config.coach ?? {}) });
    } catch {
      setCoachFlags(DEFAULT_COACH_FLAGS);
    }
  }, [client]);

  useEffect(() => {
    void refreshCoachFlags();
  }, [refreshCoachFlags]);

  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [bankFilters, setBankFilters] = useState<SearchOptions>({});
  const [navigateBySession, setNavigateBySession] = useState(false);

  const refreshSession = useCallback(async () => {
    try {
      setSession(await client.getSession());
    } catch {
      setSession(null);
    }
  }, [client]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  /* ------------------------------------------------------------------ tabs */

  const [tabState, dispatchTabs] = useReducer(tabsReducer, undefined, loadTabState);
  const tabsRef = useRef(tabState);
  tabsRef.current = tabState;

  const announceAutosave = useCallback((tabId: string, title: string) => {
    if (loadAutosaveBanner() === "off") return;
    const visible = visibleTabIds(tabsRef.current);
    if (!autosaveBannerAllowed(tabId, visible)) return;
    setNotice((current) => coalesceAutosaveNotice(current, title, visible.length > 1));
  }, []);

  useEffect(() => {
    saveTabState(tabState);
  }, [tabState]);

  /**
   * What a workspace will answer if the shell asks it to let go.
   *
   * Keyed by tab id, because a switch has two workspaces alive for the length
   * of a render and the outgoing one is the one being asked.
   */
  const apisRef = useRef(new Map<string, WorkspaceApi>());
  const setWorkspaceApi = useCallback((id: string, api: WorkspaceApi | null) => {
    if (api) apisRef.current.set(id, api);
    else apisRef.current.delete(id);
  }, []);

  const [chrome, setChromeState] = useState<WorkspaceChrome>(NO_CHROME);
  const setChrome = useCallback((next: WorkspaceChrome) => {
    setChromeState((current) => (chromeLooksSame(current, next) ? current : next));
  }, []);

  const [shellLoadActive, setShellLoadActive] = useState(false);
  const userLoadIdsRef = useRef(new Set<string>());
  const markUserLoad = useCallback((id: string) => {
    userLoadIdsRef.current.add(id);
  }, []);
  const takeUserLoad = useCallback((id: string) => {
    if (!userLoadIdsRef.current.has(id)) return false;
    userLoadIdsRef.current.delete(id);
    return true;
  }, []);

  /** A tab whose content could not be found when it was opened. */
  const [missingTab, setMissingTab] = useState<{
    id: string;
    title: string;
    detail: string;
  } | null>(null);
  const onMissingContent = useCallback((id: string, title: string, detail: string) => {
    setMissingTab({ id, title, detail });
  }, []);

  /*
   * Retry generations, per tab.
   *
   * Bumped by Try again; the generation joins that tab's mount key, so the
   * workspace reloads. Per tab, not one token for the app: a shared counter
   * only stayed stable while every key agreed on it, and the keys also folded
   * in `active` — so after the first retry anywhere, every subsequent tab
   * switch changed the key of both the tab being left and the one arriving.
   */
  const [retryByTab, setRetryByTab] = useState<Record<string, number>>({});

  /*
   * A failure belongs to the tab it happened in.
   *
   * The banner is the shell's — one strip across the top, shared by every
   * workspace — so a note that would not open left "This document did not
   * finish opening" standing over the *browser* tab you switched to next. The
   * page under it had loaded perfectly well; the only broken thing on screen
   * was a sentence about a different document. Switching tabs takes it down.
   */
  useEffect(() => {
    setError(null);
    setNotice(null);
  }, [tabState.activeId]);

  const [browseMotion, setBrowseMotion] = useState<
    "enter" | "idle" | "busy" | "exit" | "done"
  >("idle");
  const [holdBrowseOverlay, setHoldBrowseOverlay] = useState(false);
  const overlayTopRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = overlayTopRef.current;
    if (!node) return;
    const app = node.closest(".lc-app");
    const apply = () => {
      const height = node.offsetHeight;
      (app as HTMLElement | null)?.style.setProperty(
        "--lc-top-banner-h",
        height > 0 ? `${height}px` : "0px",
      );
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => {
      observer.disconnect();
      (app as HTMLElement | null)?.style.removeProperty("--lc-top-banner-h");
    };
  }, []);

  /**
   * Which workspaces are mounted, most recently looked at first.
   *
   * Switching no longer parks anything, and that is the whole of "switching
   * stopped reloading": the tab you left is still mounted, so coming back is
   * showing it again rather than reading it out of the store and re-fitting a
   * board. Only falling off the end of this list costs anything.
   */
  const [liveIds, setLiveIds] = useState<string[]>(() => visibleTabIds(tabState));
  const promote = useCallback((id: string) => {
    setLiveIds((current) => promoteLive(current, id));
  }, []);

  const visibleIds = useMemo(() => visibleTabIds(tabState), [tabState]);
  const activeGroup = groupOf(tabState, tabState.activeId);
  const groupHasExplore = Boolean(
    activeGroup?.children.some(
      (id) => tabState.tabs.find((tab) => tab.id === id)?.kind === "explore",
    ),
  );
  const groupHasBoard = Boolean(
    activeGroup?.children.some((id) => {
      const kind = tabState.tabs.find((tab) => tab.id === id)?.kind;
      return kind != null && kind !== "home" && kind !== "explore";
    }),
  );

  /*
   * Split widths live as CSS variables on `<main>`, not as React style.
   * Writing them from render fights the sash: every App paint (ink, Excalidraw)
   * stamped the stored 0.5 back over the drag. Sync from state only while the
   * pointer is up; while it is down the sash owns the variables.
   */
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    /*
     * The pen's floating chrome is not in the pane — it portals to the body —
     * so it rides the document element rather than `<main>`. Outside the sash
     * guard: which layout we are in does not change while a sash is dragged,
     * and re-scaling the wheel mid-drag would be a strange thing to watch.
     */
    applyInkChromeScale(document.documentElement, Boolean(activeGroup));
    if (document.body.dataset.lcSashDrag) return;
    if (!activeGroup) {
      main.style.removeProperty("--lc-split-a");
      main.style.removeProperty("--lc-split-b");
      return;
    }
    main.style.setProperty("--lc-split-a", String(activeGroup.split.ratio));
    main.style.setProperty("--lc-split-b", String(1 - activeGroup.split.ratio));
  }, [activeGroup]);

  /*
   * Split panes occupy the live slots first. Without that, one half falls off
   * the budget and remounts the first time you look at it.
   */
  useEffect(() => {
    const known = new Set(tabState.tabs.map((tab) => tab.id));
    setLiveIds((current) => {
      const trimmed = current.filter((id) => known.has(id));
      const withHome = trimmed.includes(HOME_TAB_ID) ? trimmed : [...trimmed, HOME_TAB_ID];
      const base =
        withHome.length === current.length && withHome.every((id, i) => id === current[i])
          ? current
          : withHome;
      return pinLive(base, visibleIds);
    });
  }, [tabState.tabs, visibleIds]);

  /**
   * Evicting is where the parking went.
   *
   * A workspace past the limit is flushed *before* it is dropped, and it stays
   * mounted for the length of that flush — its board handle is what the flush
   * writes through, so unmounting first would save through a torn-down board.
   * That is the whole reason this is an effect over a list rather than a `key`
   * that simply stops matching.
   */
  useEffect(() => {
    /*
     * A split occupies two live slots. Raise the budget by one so the tab
     * just left still stays mounted — otherwise both halves eat the floor
     * of two and switching away remounts.
     */
    const liveLimit = Math.max(LIVE_LIMIT, visibleIds.length + 1);
    const doomed = liveOverflow(liveIds, liveLimit);
    if (doomed.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const id of doomed) {
        await apisRef.current.get(id)?.park().catch(() => {});
      }
      if (!cancelled) setLiveIds((current) => current.filter((x) => !doomed.includes(x)));
    })();
    return () => {
      cancelled = true;
    };
  }, [liveIds, visibleIds.length]);

  const focusTab = useCallback(
    (id: string) => {
      const state = tabsRef.current;
      const tab = state.tabs.find((entry) => entry.id === id);
      if (!tab) return;
      // Practice lives on the Home workspace as an overlay. The chip is already
      // selected, so a no-op here left the problem list up instead of the cards.
      if (id === HOME_TAB_ID) apisRef.current.get(HOME_TAB_ID)?.showHomeChooser?.();
      if (id === state.activeId) return;
      // The strip is chrome for the focused book only. Leaving it open as a
      // global meant both split PDFs filled thumbs at once — a 44 MB file
      // next to a short one. Clicking the other tab (or its pane) closes it;
      // "Show page previews" on the newly focused book turns it back on.
      // Unpersisted, so the next launch still follows the last explicit toggle.
      setPdfFilmOpen(false);
      setMissingTab(null);
      setError(null);
      promote(id);
      dispatchTabs({ type: "focus", id, at: Date.now() });
    },
    [promote],
  );

  const openWorkspace = useCallback(
    (proposed: TabRecord): TabRecord => {
      // The reducer decides which chip an open lands in; `openedRecord` is the
      // same call it makes, so the answer here cannot disagree with it.
      const landed = openedRecord(tabsRef.current, proposed);
      if (landed.id === tabsRef.current.activeId) return landed;
      const existed = tabsRef.current.tabs.some((tab) => tab.id === landed.id);
      if (!existed) {
        markUserLoad(landed.id);
        setShellLoadActive(true);
      }
      setMissingTab(null);
      setError(null);
      promote(landed.id);
      dispatchTabs({ type: "open", tab: proposed, at: Date.now() });
      return landed;
    },
    [markUserLoad, promote, setShellLoadActive],
  );

  const closeTab = useCallback((id: string) => {
    if (id === HOME_TAB_ID) return;
    const state = tabsRef.current;
    const drop = (clearMissing: boolean) => {
      const next = tabsReducer(tabsRef.current, { type: "close", id });
      dispatchTabs({ type: "close", id });
      setLiveIds((current) => current.filter((x) => x !== id));
      if (clearMissing) setMissingTab(null);
      // Closing a document does not go through focusTab, so Home never got
      // showHomeChooser — the Document picker on the parked Home instance
      // stayed up. Same reset the brand/chip uses.
      if (next.activeId === HOME_TAB_ID) {
        apisRef.current.get(HOME_TAB_ID)?.showHomeChooser?.();
      }
    };
    if (id !== state.activeId) {
      // Not on screen — but it may still be mounted behind this one, so it is
      // asked the same question rather than dropped out from under itself.
      const parked = apisRef.current.get(id);
      if (parked?.isLoadActive()) {
        // Still opening: there is nothing to save. Abort, then drop the chip.
        void parked.abortLoad().then(() => drop(false)).catch(() => drop(false));
        return;
      }
      if (parked) {
        void parked.leave().then(() => drop(false));
        return;
      }
      // A record and nothing else; dropping it is the whole of closing it, and
      // its content stays in whichever library holds it.
      dispatchTabs({ type: "close", id });
      return;
    }
    const live = apisRef.current.get(id);
    if (!live) {
      drop(true);
      return;
    }
    if (live.isLoadActive()) {
      // Same as overlay Cancel: stop the open, then drop the unfinished chip.
      void live.abortLoad().then(() => drop(true)).catch(() => drop(true));
      return;
    }
    // Closing really is leaving, so it asks. A cancel simply never resolves.
    void live.leave().then(() => drop(true));
  }, []);

  /**
   * Cancel: play the load-complete hold, then drop the unfinished chip.
   *
   * `abortLoad` bumps the generation guard (in-flight work becomes a no-op)
   * and holds the spinner on its checkmark the same length a successful open
   * would. Closing happens after that hold. Nothing is asked on the way out
   * because a workspace that never finished opening has nothing to save.
   */
  const cancelLoad = useCallback(() => {
    const id = tabsRef.current.activeId;
    const target = apisRef.current.get(id) ?? apisRef.current.get(HOME_TAB_ID);
    void (async () => {
      await target?.abortLoad().catch(() => {});
      const still = tabsRef.current.activeId;
      if (still !== HOME_TAB_ID && still === id) {
        dispatchTabs({ type: "close", id: still });
        setLiveIds((current) => current.filter((entry) => entry !== still));
      }
      setMissingTab(null);
      setError(null);
      setShellLoadActive(false);
    })();
  }, []);

  const patchTab = useCallback((id: string, patch: TabPatch) => {
    dispatchTabs({ type: "patch", id, patch });
  }, []);
  const webPush = useCallback((id: string, entry: WebPadEntry) => {
    dispatchTabs({ type: "web-push", id, entry });
  }, []);
  const webStep = useCallback((id: string, delta: number) => {
    dispatchTabs({ type: "web-step", id, delta });
  }, []);

  const splitTabs = useCallback((anchor: string, incoming: string, edge: SplitEdge) => {
    if (anchor === HOME_TAB_ID || incoming === HOME_TAB_ID || anchor === incoming) return;
    dispatchTabs({
      type: "split",
      a: anchor,
      b: incoming,
      axis: "vertical",
      edge,
      at: Date.now(),
    });
    setLiveIds((current) => pinLive(current, [anchor, incoming]));
  }, []);

  const unsplitTab = useCallback((id: string) => {
    dispatchTabs({ type: "unsplit", id });
  }, []);

  /*
   * The chip menu's split, which is the drag's outcome without the gesture.
   *
   * The drag picks its partner by where you drop — this picks the tab already
   * on screen, because that is the only other pane in play. Home is not a
   * partner: splitting with the landing page would put two of it on screen.
   */
  const splitWithActive = useCallback(
    (id: string, edge: SplitEdge) => {
      const anchor = tabsRef.current.activeId;
      if (anchor === id || anchor === HOME_TAB_ID) return;
      splitTabs(anchor, id, edge);
    },
    [splitTabs],
  );

  /** Which tabs are half of a split — the menu says `Unsplit` for those. */
  const groupedIds = useMemo(
    () => tabState.groups.flatMap((group) => group.children),
    [tabState.groups],
  );

  const setSplitRatio = useCallback((groupId: string, ratio: number) => {
    dispatchTabs({ type: "set-ratio", groupId, ratio });
  }, []);

  const onTabDropOnTab = useCallback(
    (dragId: string, ontoId: string) => {
      if (ontoId === HOME_TAB_ID || dragId === ontoId) return;
      /*
       * Two halves of one split: the drop can only mean "put me on the other
       * side".
       *
       * It used to rebuild the same pair in the same order, so dragging the
       * right-hand chip over to the left did nothing — the one gesture anyone
       * would try for swapping the panes was the one that was silently a
       * no-op.
       */
      const paired = tabsRef.current.groups.some(
        (group) => group.children.includes(dragId) && group.children.includes(ontoId),
      );
      if (paired) {
        dispatchTabs({ type: "swap-split", id: dragId });
        return;
      }
      splitTabs(ontoId, dragId, "right");
    },
    [splitTabs],
  );

  /*
   * The header's slots, as state rather than refs: a portal needs the element
   * to exist, and a ref assignment does not re-render to say that it now does.
   */
  const [headerLeft, setHeaderLeft] = useState<HTMLElement | null>(null);
  const [headerCenter, setHeaderCenter] = useState<HTMLElement | null>(null);
  const [headerRight, setHeaderRight] = useState<HTMLElement | null>(null);
  const [headerChrome, setHeaderChrome] = useState<HTMLElement | null>(null);
  const [boardChrome, setBoardChrome] = useState<HTMLElement | null>(null);
  const [agentPanel, setAgentPanel] = useState<HTMLElement | null>(null);
  const headerSlots: HeaderSlots = useMemo(
    () => ({
      left: headerLeft,
      center: headerCenter,
      right: headerRight,
      chrome: headerChrome,
      boardChrome,
      agentPanel,
    }),
    [agentPanel, boardChrome, headerCenter, headerChrome, headerLeft, headerRight],
  );

  const activeRecord = activeTabOf(tabState);

  /*
   * Home stays mounted while its overlay is still sliding away.
   *
   * Opening from the cards switches the tab immediately, but the beats that
   * carry the chooser off screen belong to the workspace that is leaving — so
   * it is kept alive for the length of them. This is the floor of the mount
   * budget the split panes will build on.
   */
  /*
   * The mounted set, and which of them is painted.
   *
   * Everything in `liveIds` stays mounted; only the active one is laid out.
   * The exception is Home while its overlay is still sliding away — the beats
   * that carry the chooser off screen belong to the tab being left, so it is
   * kept *visible* over the one arriving underneath, which is exactly where
   * the overlay sat when there was only ever one canvas.
   */
  const liveTabs = useMemo(() => {
    const transitioning = browseMotion !== "idle" || holdBrowseOverlay;
    const ids = liveIds.includes(activeRecord.id) ? liveIds : [activeRecord.id, ...liveIds];
    const painted = new Set(visibleIds);
    return ids
      .map((id) => tabState.tabs.find((tab) => tab.id === id))
      .filter((tab): tab is TabRecord => Boolean(tab))
      .map((tab) => ({
        tab,
        active: tab.id === activeRecord.id,
        showing:
          painted.has(tab.id) ||
          (tab.id === HOME_TAB_ID && transitioning && activeRecord.id !== HOME_TAB_ID),
      }));
  }, [activeRecord.id, browseMotion, holdBrowseOverlay, liveIds, tabState.tabs, visibleIds]);

  /** The one render list: every mounted workspace, with its layout. */
  const workspaceMounts = useMemo(
    () =>
      planWorkspaceMounts({
        liveTabs,
        allTabs: tabState.tabs,
        visibleIds,
        groupChildren: activeGroup ? activeGroup.children : null,
        activeId: activeRecord.id,
      }),
    [activeGroup, activeRecord.id, liveTabs, tabState.tabs, visibleIds],
  );

  const shell: ShellValue = useMemo(
    () => ({
      client,
      mobile,
      serverLink,
      serverLinkRef,
      themeId,
      setThemeId,
      readingSize,
      setReadingSize,
      autosaveMs,
      setAutosaveMs,
      testForward,
      setTestForward,
      sheetDragLocked,
      setSheetDragLocked,
      pdfFilmOpen,
      setPdfFilmOpen,
      recognizer,
      capabilities,
      coachFlags,
      llmLink,
      refreshCoachFlags,
      settingsOpen,
      setSettingsOpen,
      setSettingsTab,
      notice,
      setNotice,
      announceAutosave,
      error,
      setError,
      browseMotion,
      setBrowseMotion,
      holdBrowseOverlay,
      setHoldBrowseOverlay,
      session,
      setSession,
      refreshSession,
      navigateBySession,
      setNavigateBySession,
      bankFilters,
      setBankFilters,
      openWorkspace,
      focusTab,
      closeTab,
      splitTabs,
      patchTab,
      webPush,
      webStep,
      tabsRef,
      headerSlots,
      setChrome,
      setWorkspaceApi,
      shellLoadActive,
      setShellLoadActive,
      markUserLoad,
      takeUserLoad,
      onMissingContent,
    }),
    [
      autosaveMs, bankFilters, browseMotion, capabilities, client, closeTab, coachFlags, error,
      focusTab, headerSlots, holdBrowseOverlay, llmLink, mobile, navigateBySession, notice,
      announceAutosave, onMissingContent, openWorkspace, patchTab, pdfFilmOpen, readingSize, recognizer,
      refreshCoachFlags, refreshSession, serverLink, session, setChrome, setWorkspaceApi,
      settingsOpen, setShellLoadActive, sheetDragLocked, shellLoadActive, markUserLoad, takeUserLoad, testForward, themeId,
      splitTabs, webPush, webStep,
    ],
  );

  return (
    <ShellContext.Provider value={shell}>
      <div
        className={[
          "lc-app",
          mobile ? "lc-mobile" : "",
          android ? "lc-android" : "",
          chrome.problem ? "lc-app-problem" : "",
          chrome.pad ? "lc-app-pad" : "",
          chrome.agentOpen ? "lc-app-agent-open" : "",
          chrome.loading || shellLoadActive ? "lc-app-loading" : "",
          bootPhase !== "gone" && bootPhase !== "exit" ? "lc-app-booting" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <header className="lc-header">
          <div className="lc-header-left">
          {/*
            The logo *is* Home.
            
            It was a tab, which made it compete for width with the documents you
            actually have open and left a gap in the strip when it was shrunk to
            fit. A house that always sits in the same corner is the thing every
            application already uses to mean "back to the start", so there is no
            reason to spend a tab slot saying it twice.
          */}
          <Tip tip="Home">
            <button
              type="button"
              className="lc-brand lc-brand-home"
              aria-label="Home"
              onClick={() => {
                // Going Home also drops whatever was loading, the way the Home
                // chip used to.
                if (shellLoadActive) cancelLoad();
                focusTab(HOME_TAB_ID);
              }}
            >
              <BrandHome />
            </button>
          </Tip>
          {/*
            The strip is the title slot. It carries Home, every open workspace
            and the `[indexed]` badge, and it lives in the shell so switching
            tabs does not remount it out from under the tap that switched.
          */}
          <TabStrip
            tabs={tabState.tabs}
            groups={tabState.groups}
            activeId={tabState.activeId}
            busy={chrome.busy || shellLoadActive}
            onFocus={focusTab}
            onClose={closeTab}
            onCancelLoad={shellLoadActive ? cancelLoad : undefined}
            onTabDropOnTab={onTabDropOnTab}
            onSplitWithActive={splitWithActive}
            onUnsplit={unsplitTab}
            groupedIds={groupedIds}
            onRename={(id, title) => {
              const record = tabState.tabs.find((entry) => entry.id === id);
              if (!record) return;
              patchTab(id, { title });
              void renameTabPad(client, record, title);
            }}
            activeIndexChip={
              chrome.docIndex.status === "idle" &&
              !chrome.docIndex.onIndex &&
              !chrome.docIndex.walkStage ? undefined : (
                <DocIndexChip
                  status={chrome.docIndex.status}
                  meta={chrome.docIndex.meta as never}
                  error={chrome.docIndex.error}
                  onIndex={chrome.docIndex.onIndex}
                  onEmbed={chrome.docIndex.onEmbed}
                  indexProgress={chrome.docIndex.indexProgress}
                  embedProgress={chrome.docIndex.embedProgress}
                  embedEta={chrome.docIndex.embedEta}
                  embedding={chrome.docIndex.embedding}
                  blocked={chrome.docIndex.blocked}
                  syncIssue={chrome.docIndex.syncIssue}
                  walkStage={chrome.docIndex.walkStage}
                  walkJob={chrome.docIndex.walkJob}
                  walkProgress={chrome.docIndex.walkProgress}
                  walkError={chrome.docIndex.walkError}
                  walkWaiting={chrome.docIndex.walkWaiting}
                />
              )
            }
          />
            <span className="lc-header-slot" ref={setHeaderLeft} />
          </div>

          <div className="lc-header-center" ref={setHeaderCenter} />

          <div className="lc-header-right" ref={setHeaderRight} />
        </header>

        <span className="lc-header-slot" ref={setHeaderChrome} />

        <main
          ref={mainRef}
          className={[
            "lc-main",
            activeGroup ? "is-split-vertical" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <div className="lc-chrome-overlay-top" aria-live="polite" ref={overlayTopRef}>
            <StatusBanner text={error} variant="error" />
            <StatusBanner text={!error ? notice : null} variant="notice" />
          </div>
          {/*
            One list, one `.map()`: see `planWorkspaceMounts`. Parked, on
            screen and overlay are *props*, not separate arrays — moving a
            keyed workspace between arrays remounts it, and a tab switch moves
            two of them. The sash and the toast are siblings after this list,
            never between workspaces.
          */}
          {workspaceMounts.map(({ tab, active, showing, splitRole }) => (
            <Workspace
              key={workspaceMountKey(tab.id, retryByTab)}
              tab={tab}
              active={active}
              showing={showing}
              splitRole={splitRole}
              splitKeepChrome={Boolean(splitRole && groupHasExplore)}
              embedInBoardTray={Boolean(splitRole && groupHasBoard)}
            />
          ))}
          {activeGroup ? (
            <>
              <SplitSash
                axis="vertical"
                onRatio={(ratio) => setSplitRatio(activeGroup.id, ratio)}
              />
              {/*
                Keyed on the group so re-splitting starts silent again — the
                toast is for focus moving *within* a split, not for one opening.
              */}
              <SplitFocusToast
                key={activeGroup.id}
                side={activeGroup.children[0] === activeRecord.id ? "a" : "b"}
                label={
                  tabState.tabs.find((tab) => tab.id === activeRecord.id)?.title ??
                  "Tab"
                }
              />
            </>
          ) : null}
          <span className="lc-board-chrome-slot" ref={setBoardChrome} />
        </main>

        <span className="lc-agent-slot" ref={setAgentPanel} />

      {missingTab && (
        <div
          className="lc-modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setMissingTab(null);
          }}
        >
          <div className="lc-modal" role="dialog" aria-modal="true" aria-label="Tab is empty">
            <h2>“{missingTab.title}” could not be opened</h2>
            <p>{missingTab.detail}</p>
            <p className="lc-muted">
              The tab is still here and still empty. Closing it throws nothing away.
            </p>
            <div className="lc-modal-actions">
              <button
                type="button"
                className="lc-secondary"
                onClick={() => {
                  // Remounting is retrying: the workspace loads on mount, so a
                  // fresh key is the whole of "try that again".
                  setMissingTab(null);
                  setRetryByTab((map) => bumpRetry(map, missingTab.id));
                }}
              >
                Try again
              </button>
              <button type="button" className="lc-secondary" onClick={() => setMissingTab(null)}>
                Keep it empty
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = missingTab.id;
                  setMissingTab(null);
                  closeTab(id);
                }}
              >
                Close tab
              </button>
            </div>
          </div>
        </div>
      )}

      {bootPhase !== "gone" && (
        <div
          className={[
            "lc-server-gate-boot",
            bootPhase === "exit" ? "lc-server-gate-boot-exit" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="status"
          aria-live="polite"
          aria-label={bootPhase === "done" ? "Ready" : "Starting up"}
        >
          <LoadingDoodle themeId={themeId} />
          {bootPhase === "done" ? (
            <div className="lc-spinner-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22">
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
          ) : (
            <div className="lc-spinner" aria-hidden="true" />
          )}
        </div>
      )}

      {llmGateOpen && (
        <LlmStatusDialog
          phase={llmGatePhase}
          onOpenSettings={() => {
            closeLlmGate();
            setSettingsTab("llm");
            setSettingsOpen(true);
          }}
          onContinueWithout={() => {
            closeLlmGate();
            setNotice("Agent off — Settings → LLM when you want it back.");
          }}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        client={client}
        initialTab={settingsTab as never}
        coachStatus={serverLink === "online" ? llmLink : "offline"}
        coachDetail={llmDetail}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsTab(undefined);
          if (serverLink === "online") void probeLlm();
        }}
        onSaved={() => {
          void client.capabilities().then(setCapabilities).catch(() => setCapabilities(null));
          // Turning `ws_runs` on or off changes whether the socket is open at
          // all, so the flags have to be re-read, not just saved.
          void refreshCoachFlags();
          if (serverLink === "online") void probeLlm();
        }}
      />
      <SmartTips />
      </div>
    </ShellContext.Provider>
  );
}
