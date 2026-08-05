/**
 * The whole loop, wired together.
 *
 * The coach answers when asked: draw, tap Submit, get a verdict and a
 * counterexample. (The ambient every-2m WebSocket mode is wired but off —
 * see `AMBIENT_ENABLED`.)
 *
 * Everything talks to `lc serve`. Nothing about the corpus, the workspaces, or
 * the Python runner lives on this device — including which problem set is
 * open: a problem carries its `dataset` slug, and every request that names a
 * task id names the dataset too.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LcApiError, LcClient, type SearchOptions } from "./api/client";
import { AmbientCoach, type AmbientProbe } from "./api/coachSocket";
import {
  DEFAULT_PORT,
  loadPairing,
  normalizePairCode,
  pairWithCode,
  pairingBaseUrl,
  parsePairingUrl,
  savePairing,
  type Pairing,
} from "./api/pairing";
import type {
  AttemptState,
  CoachFlags,
  CoachProcessEvent,
  DrawReviewEnvelope,
  LazyFillResponse,
  ProblemDetail,
  ReviewResponse,
  RunAction,
  ServerFrame,
  SessionSnapshot,
  TestResponse,
  VizEnvelope,
} from "./api/types";
import { DEFAULT_COACH_FLAGS, DEFAULT_DATASET } from "./api/types";
import { Tip } from "./components/Tip";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HoldButton } from "./components/HoldButton";
import { LoadingDoodle } from "./components/LoadingDoodle";
import { LlmStatusDialog } from "./components/LlmStatusDialog";
import { ServerStatusDialog, type ServerGateKind } from "./components/ServerStatusDialog";
import { SettingsModal } from "./components/SettingsModal";
import { offlinePackDownloader } from "./util/offlinePackDownload";
import { StatusBanner } from "./components/StatusBanner";
import { SmartTips } from "./components/SmartTips";
import { Board } from "./canvas/Board";
import { saveBoardReadingSize, type BoardReadingSize } from "./modes/codeFontSize";
import type { BoardHandle, ScreenRect } from "./canvas/BoardHandle";
import { studentAuthoredElements, studentElements } from "./canvas/capture";
import type { StructureBaseline } from "./canvas/boardDelta";
import { MlKitRecognizer, NoopRecognizer, pickRecognizer, type InkRecognizer } from "./canvas/ink";
import { buildSnapshot, sceneFingerprint, structureBaselineFromBoard } from "./canvas/snapshot";
import { hasCodeAnnotations, renderAnnotatedCode } from "./canvas/codeAnnotation";
import { BOARD_THEMES } from "./templates/skeleton";
import { statementLinePitch } from "./modes/codeFontSize";
import { sha256Hex } from "./util/codeHash";
import { HOLD_SENSITIVE_MS } from "./util/gesture";
import { skeletonOf } from "./util/solutionSplit";
import {
  AgentSidePanel,
  AMBIENT_ENABLED,
  type CoachChatMessage,
  type CoachSendFlags,
} from "./modes/AgentSidePanel";
import { AttemptDialog } from "./modes/AttemptDialog";
import { ScratchpadDialog } from "./modes/ScratchpadDialog";
import { describeRunFailure, withConversationContext } from "./modes/coachContext";
import { loadForwardFailures, saveForwardFailures } from "./util/coachPrefs";
import { ensureTypingImports } from "./util/pythonImports";

/** Room under the last line of code so a note fits below it. */
const CODE_PAGE_TAIL = 160;
import { ScratchpadLibraryDialog } from "./modes/ScratchpadLibraryDialog";
import { formatTestReport, TestResultsModal } from "./modes/TestResultsModal";
import { AmbientPanel, type AmbientEntry } from "./modes/AmbientPanel";
import { ProblemBrowser } from "./modes/ProblemBrowser";
import { PseudocodeEditor } from "./modes/PseudocodeEditor";
import { RevealDialog } from "./modes/RevealDialog";
import { buildProblemTemplate } from "./templates/problemBoard";
import {
  buildScratchPageSkeletons,
  buildScratchpadTemplate,
  countScratchPages,
  SCRATCHPAD_DATASET,
  SCRATCHPAD_TASK_ID,
  scratchPageId,
} from "./templates/scratchpad";
import { MOBILE_REGION_ORDER, REGIONS, type RegionId } from "./templates/regions";
import { splitProblemKey } from "./util/datasetKey";
import { useIsMobile } from "./util/mobile";
import { installSafeAreaInsets } from "./util/safeArea";
import { MdInkDialog } from "./modes/MdInkDialog";
import { MdInkDocument } from "./modes/MdInkDocument";
import {
  buildMdInkTemplate,
  mdInkFrameWidthFromElements,
  mdInkPageHeight,
  mdInkPageWidthForViewport,
  MD_INK_DATASET,
  MD_INK_PAGE_W,
  MD_INK_REGION,
  MD_INK_TASK_ID,
} from "./templates/mdInk";
import {
  buildMdInkSidecar,
  exportMdInkSidecar,
  pickMarkdownFile,
  pickSidecarFile,
  readMdInkSidecar,
} from "./util/mdInkFs";
import {
  deleteMdInkDoc,
  findMdInkDocByHash,
  findStaleMdInkDoc,
  getMdInkDoc,
  hashMarkdown,
  MdInkLibraryFullError,
  restoreMdInkDoc,
  saveMdInkDoc,
  type MdInkDoc,
} from "./util/mdInkStore";
import {
  deleteScratchNotebook,
  getScratchNotebook,
  migrateLegacyScratchpad,
  restoreScratchNotebook,
  saveScratchNotebook,
  ScratchpadLibraryFullError,
  SCRATCHPAD_PAGE_LIMIT,
  scratchLibraryCount,
  SCRATCHPAD_LIBRARY_LIMIT,
  type ScratchNotebook,
} from "./util/scratchpadStore";
import { resolveSolutionSource } from "./util/solutionTemplate";
import { titleFromSlug } from "./util/text";
import { ensureCodingRoom } from "./util/solutionPad";
import { applyAppTheme, isDarkTheme, loadThemeId, saveThemeId } from "./theme/appThemes";
import {
  enforceVisibleDrawingCap,
  restoreMessageDrawing,
  setDrawingExpanded,
  visibleDrawings,
  withNewDrawing,
  MAX_VISIBLE_DRAWINGS,
} from "./viz/drawingState";
import {
  applyAnnotation,
  applyHighlight,
  applyViz,
  removeViz,
  type SceneApi,
} from "./viz/apply";
import { renderAnnotation } from "./viz/render/annotation";
import { renderHighlight } from "./viz/render/highlight";
import { parseVizProgram, type VizProgram } from "./viz/schema";
import type { CoachCapabilities } from "./api/types";

type Mode = "review" | "ambient";

const SCRATCHPAD_PROBLEM: ProblemDetail = {
  dataset: SCRATCHPAD_DATASET,
  key: `${SCRATCHPAD_DATASET}/${SCRATCHPAD_TASK_ID}`,
  task_id: SCRATCHPAD_TASK_ID,
  question_id: null,
  difficulty: null,
  tags: ["scratchpad"],
  problem_description: "Freeform scratchpad — no problem set.",
  starter_code: null,
  entry_point: null,
  cases: [],
};

function isScratchpad(problem: ProblemDetail | null | undefined): boolean {
  return problem?.task_id === SCRATCHPAD_TASK_ID;
}

/** Annotating a markdown file — a scratchpad whose paper is somebody's notes. */
const MD_INK_PROBLEM: ProblemDetail = {
  dataset: MD_INK_DATASET,
  key: `${MD_INK_DATASET}/${MD_INK_TASK_ID}`,
  task_id: MD_INK_TASK_ID,
  question_id: null,
  difficulty: null,
  tags: ["md-ink"],
  problem_description: "Markdown annotation — no problem set.",
  starter_code: null,
  entry_point: null,
  cases: [],
};

function isMdInk(problem: ProblemDetail | null | undefined): boolean {
  return problem?.task_id === MD_INK_TASK_ID;
}

/**
 * Both freeform modes, for the many places that treat them alike.
 *
 * Neither has an attempt on the daemon, a test run, or a solution file; both
 * persist to a local library and both offer save / discard on the way out.
 */
function isLocalPad(problem: ProblemDetail | null | undefined): boolean {
  return isScratchpad(problem) || isMdInk(problem);
}

export function App() {
  const mobile = useIsMobile();

  useEffect(() => {
    if (!mobile) return;
    return installSafeAreaInsets();
  }, [mobile]);

  /**
   * Mobile paging. Desktop keeps the one wide stacked canvas; on a tablet each
   * dashed template frame gets the viewport to itself, in the order a session
   * actually moves through them.
   */
  const [activeRegion, setActiveRegion] = useState<RegionId>("constraints");
  const [scratchPageIndex, setScratchPageIndex] = useState(0);
  const [scratchPageCount, setScratchPageCount] = useState(1);
  const [scratchNotebookId, setScratchNotebookId] = useState<string | null>(null);
  const [scratchEntryOpen, setScratchEntryOpen] = useState(false);
  /**
   * The pen owns the code page: the editor stops taking pointers so strokes
   * reach the ink layer instead of the textarea underneath them.
   */
  const [annotateCode, setAnnotateCode] = useState(false);
  /**
   * Monaco's full content height, so the code page can be as tall as the code.
   *
   * Annotation is why this exists. Ink is stored in board scene coordinates; an
   * editor that scrolls its own viewport slides the text out from under marks
   * that stay put, so a note drawn on line 30 ends up beside line 12. Laying
   * the editor out at full height and letting the board do the scrolling puts
   * both on the one transform.
   */
  const [codeContentHeight, setCodeContentHeight] = useState<number | null>(null);
  const [scratchLibOpen, setScratchLibOpen] = useState(false);
  const scratchLibResumeRef = useRef<(() => void) | null>(null);
  /**
   * What the library held for this notebook when the session opened.
   *
   * Discard used to be a lie. The board autosaves every three seconds, so by
   * the time anyone reached the leave dialog their work was already committed
   * to the library — and "Discard" then did nothing but navigate away, leaving
   * exactly what it claimed to throw out. Which also meant Save was
   * unfalsifiable: it looked like it worked because the autosave had already
   * done it.
   *
   * Keeping the entry point state is what makes both honest. Discard restores
   * this, and a notebook that was not in the library when the session opened is
   * restored by deleting it. The autosave keeps its real job — surviving a
   * crash or a killed tab — without deciding what the writer meant to keep.
   */
  const scratchBaselineRef = useRef<{ id: string | null; entry: ScratchNotebook | null }>({
    id: null,
    entry: null,
  });
  /**
   * Fingerprint of the notebook as it was opened, for "did they write
   * anything?". Compared against the live board — see {@link scratchUntouched}.
   */
  const scratchPristineHashRef = useRef<number | null>(null);

  /** The markdown being annotated: its text, its name, and its content hash. */
  const [mdInkSource, setMdInkSource] = useState<{
    name: string;
    text: string;
    hash: string;
  } | null>(null);
  /** Library entry this session is writing to, once it has one. */
  const [mdInkDocId, setMdInkDocId] = useState<string | null>(null);
  const [mdInkEntryOpen, setMdInkEntryOpen] = useState(false);
  // Read from the autosave interval, which must not be torn down and rebuilt
  // every time one of these changes — a restarted timer is a skipped save.
  const mdInkSourceRef = useRef<{ name: string; text: string; hash: string } | null>(null);
  const mdInkDocIdRef = useRef<string | null>(null);
  /**
   * Measured document height, in scene units, driving the page frame.
   *
   * A page that ended before the text did would clip ink off the bottom of a
   * long document, so the frame is grown to the markdown rather than the other
   * way round.
   */
  const [mdInkHeight, setMdInkHeight] = useState<number | null>(null);
  /** Scene width of the open markdown page — viewport-sized on fresh opens. */
  const [mdInkPageWidth, setMdInkPageWidth] = useState(MD_INK_PAGE_W);
  const onMdInkMeasure = useCallback((height: number) => {
    setMdInkHeight((prev) =>
      prev !== null && Math.abs(prev - height) < 1 ? prev : height,
    );
  }, []);
  /** Same discard contract as the scratchpad — see `scratchBaselineRef`. */
  const mdInkBaselineRef = useRef<{ id: string | null; entry: MdInkDoc | null }>({
    id: null,
    entry: null,
  });
  const mdInkPristineHashRef = useRef<number | null>(null);
  mdInkSourceRef.current = mdInkSource;
  mdInkDocIdRef.current = mdInkDocId;

  const [pairing, setPairing] = useState<Pairing>(() => loadPairing());
  const [pairingEditing, setPairingEditing] = useState(false);
  const client = useMemo(() => new LcClient(pairing), [pairing]);

  /** Background offline pack download — survives leaving Settings; pauses on app background. */
  useEffect(() => {
    offlinePackDownloader.bindClient(client);
    void offlinePackDownloader.hydrate();
  }, [client]);

  useEffect(() => {
    const onBackground = () => offlinePackDownloader.onBackground();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onBackground();
      else offlinePackDownloader.onForeground();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onBackground);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onBackground);
    };
  }, []);

  /** Reachability of `lc serve` — offline skips problem/tests/coach that need it. */
  const [serverLink, setServerLink] = useState<"checking" | "online" | "offline">("checking");
  const [bootPhase, setBootPhase] = useState<"enter" | "show" | "exit" | "gone">("enter");
  const [gateOpen, setGateOpen] = useState(false);
  const [gateKind, setGateKind] = useState<ServerGateKind>("startup");
  const [gatePhase, setGatePhase] = useState<"enter" | "open" | "exit">("enter");
  const [gateWaiting, setGateWaiting] = useState(false);
  /** Something the student should know, but which did not stop the request. */
  const [notice, setNotice] = useState<string | null>(null);
  const serverLinkRef = useRef(serverLink);
  serverLinkRef.current = serverLink;
  const gateOpenRef = useRef(gateOpen);
  gateOpenRef.current = gateOpen;
  const bootGenRef = useRef(0);

  const boardRef = useRef<BoardHandle | null>(null);
  const [recognizer, setRecognizer] = useState<InkRecognizer>(() => new NoopRecognizer());

  const pingServer = useCallback(async (): Promise<boolean> => {
    let timer = 0;
    try {
      const health = await Promise.race([
        client.health(),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () =>
              reject(
                new Error(
                  `Local server at ${pairing.baseUrl} did not answer in time — is it running?`,
                ),
              ),
            4000,
          );
        }),
      ]);
      if (health && health.ok === false) return false;
      return true;
    } catch {
      return false;
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }, [client, pairing.baseUrl]);

  const closeGate = useCallback((next: "online" | "offline", noticeText?: string | null) => {
    setGateWaiting(false);
    setGatePhase("exit");
    window.setTimeout(() => {
      setGateOpen(false);
      setServerLink(next);
      if (noticeText) setNotice(noticeText);
    }, serverGateExitMs());
  }, []);

  const openGate = useCallback((kind: ServerGateKind) => {
    setBootPhase("gone");
    setGateKind(kind);
    setGateWaiting(false);
    setGatePhase("enter");
    setGateOpen(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setGatePhase("open"));
    });
  }, []);

  // First contact with the daemon — boot spinner (doodle-able), then dialog or continue.
  // Generation counter so a remount does not leave us cancelled mid-hang forever.
  useEffect(() => {
    let cancelled = false;
    const generation = ++bootGenRef.current;
    setServerLink("checking");
    setBootPhase("enter");
    setGateOpen(false);
    setGateWaiting(false);
    window.requestAnimationFrame(() => {
      if (!cancelled && bootGenRef.current === generation) setBootPhase("show");
    });
    void (async () => {
      const ok = await pingServer();
      if (cancelled || bootGenRef.current !== generation) return;
      if (ok) {
        setBootPhase("exit");
        window.setTimeout(() => {
          if (cancelled || bootGenRef.current !== generation) return;
          setBootPhase("gone");
          setServerLink("online");
        }, serverGateExitMs());
      } else {
        // Drop the spinner immediately and show the wait/offline dialog.
        setBootPhase("gone");
        openGate("startup");
      }
    })();
    return () => {
      cancelled = true;
    };
    // pairing identity is enough — avoid openGate/ping churn cancelling a live probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing.baseUrl, pairing.token]);

  // Wait mode: keep pinging until the daemon answers.
  useEffect(() => {
    if (!gateOpen || !gateWaiting) return;
    let cancelled = false;
    const tick = async () => {
      const ok = await pingServer();
      if (cancelled || !ok) return;
      closeGate(
        "online",
        gateKind === "dropped" ? "Back online — local server is reachable again." : null,
      );
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [gateOpen, gateWaiting, pingServer, closeGate, gateKind]);

  // While online, notice a drop promptly (interval + focus / visibility).
  useEffect(() => {
    if (serverLink !== "online") return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || gateOpenRef.current) return;
      const ok = await pingServer();
      if (cancelled || ok || gateOpenRef.current) return;
      if (serverLinkRef.current !== "online") return;
      openGate("dropped");
    };
    const onUnreachable = () => {
      if (cancelled || gateOpenRef.current) return;
      if (serverLinkRef.current !== "online") return;
      openGate("dropped");
    };
    const timer = window.setInterval(() => void tick(), 8000);
    const onFocus = () => void tick();
    const onVis = () => {
      if (document.visibilityState === "visible") void tick();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("lc-server-unreachable", onUnreachable);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("lc-server-unreachable", onUnreachable);
    };
  }, [serverLink, pingServer, openGate]);

  /** Coach LLM reachability — separate from lc serve itself. */
  const [llmLink, setLlmLink] = useState<"unknown" | "online" | "offline">("unknown");
  const [llmDetail, setLlmDetail] = useState<string | null>(null);
  const [llmGateOpen, setLlmGateOpen] = useState(false);
  const [llmGatePhase, setLlmGatePhase] = useState<"enter" | "open" | "exit">("enter");
  const [settingsTab, setSettingsTab] = useState<"workspace" | "personalise" | "server" | undefined>(
    undefined,
  );
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
        setLlmDetail(`${provider} via lc serve`);
        setLlmLink("online");
        return true;
      }
      const status = await Promise.race([
        client.llmStatus(),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("LLM status timed out")), 4000);
        }),
      ]);
      const online = /LLM reachable/i.test(status.detail ?? "");
      setLlmDetail(status.detail || null);
      setLlmLink(online ? "online" : "offline");
      return online;
    } catch (cause) {
      setLlmDetail(messageOf(cause));
      setLlmLink("offline");
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

  const closeLlmGate = useCallback(() => {
    setLlmGatePhase("exit");
    window.setTimeout(() => setLlmGateOpen(false), serverGateExitMs());
  }, []);

  // After lc serve is up, check whether a model is actually available for Coach.
  useEffect(() => {
    if (serverLink !== "online") {
      setLlmLink("unknown");
      llmPromptedRef.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      const ok = await probeLlm();
      if (cancelled) return;
      if (!ok && !llmPromptedRef.current) {
        llmPromptedRef.current = true;
        openLlmGate();
      }
    })();
    const timer = window.setInterval(() => {
      void probeLlm();
    }, 12000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [serverLink, probeLlm, openLlmGate]);

  const [problem, setProblem] = useState<ProblemDetail | null>(null);
  const [mode, setMode] = useState<Mode>("review");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const [pseudocode, setPseudocode] = useState("");
  /** Drives the fade between the browser and the board. */
  const [entering, setEntering] = useState(false);
  /** Board is mounted but opacity-0 until fit settles — avoids a post-load jump. */
  const [boardPreparing, setBoardPreparing] = useState(false);
  /** Keep the problem browser overlay up while the first board fit settles. */
  const [holdBrowseOverlay, setHoldBrowseOverlay] = useState(false);

  /** Browser overlay: idle / enter / busy (spin) / exit (slide+spin) / done (check). */
  const [browseMotion, setBrowseMotion] = useState<"enter" | "idle" | "busy" | "exit" | "done">("idle");
  /** Same spinner → check transition when stepping ‹ › between problems. */
  const [switchMotion, setSwitchMotion] = useState<"idle" | "busy" | "done">("idle");
  /** Active problem-bank filter — header prev/next walk this when there's no session queue. */
  const [bankFilters, setBankFilters] = useState<SearchOptions>({});
  /** Disk practice session from `lc serve` (queue + progress). */
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  /**
   * Header ‹ › walks the session queue only after Start / Random. A plain table
   * click is just a cursor — prev/next then walk the filtered problem bank.
   */
  const [navigateBySession, setNavigateBySession] = useState(false);
  const [canStepPrev, setCanStepPrev] = useState(false);
  const [canStepNext, setCanStepNext] = useState(false);
  /** Distinguishes header Run tests vs Submit for the results panel. */
  const [lastRunKind, setLastRunKind] = useState<"run" | "submit">("run");
  const [themeId, setThemeId] = useState(loadThemeId);
  const [readingSize, setReadingSize] = useState<BoardReadingSize>("M");
  const [coachOpen, setCoachOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [codeSlot, setCodeSlot] = useState<ScreenRect | null>(null);
  const deepLinkHandled = useRef(false);
  const lastCodeSlotRef = useRef<ScreenRect | null>(null);

  const onCodeSlot = useCallback((next: ScreenRect | null) => {
    setCodeSlot((prev) => {
      if (prev === next) return prev;
      if (!prev || !next) {
        if (next) lastCodeSlotRef.current = next;
        return next;
      }
      if (
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height &&
        prev.zoom === next.zoom
      ) {
        return prev;
      }
      lastCodeSlotRef.current = next;
      return next;
    });
  }, []);

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

  const [tests, setTests] = useState<TestResponse | null>(null);
  const [capabilities, setCapabilities] = useState<CoachCapabilities | null>(null);
  /**
   * Settings → Coach. Read once at mount and after Settings saves; a daemon
   * too old to report them leaves the defaults, which is the pre-socket
   * behaviour for everything except `ws_runs`.
   */
  const [coachFlags, setCoachFlags] = useState<CoachFlags>(DEFAULT_COACH_FLAGS);

  /** Attempt state for the open problem, so the leave dialog asks the right question. */
  const [attemptState, setAttemptState] = useState<AttemptState | null>(null);
  /** Pending "you're leaving — save or discard?" choice, with what to do after. */
  const [leaving, setLeaving] = useState<{ run: () => void } | null>(null);
  const [leavingPending, setLeavingPending] = useState(false);
  const [leavingError, setLeavingError] = useState<string | null>(null);
  /** open → exit fade; dialog stays mounted through the fade then unmounts. */
  const [leavingPhase, setLeavingPhase] = useState<"open" | "exit">("open");

  /** "Reset the practice session?" — our own modal, held to confirm. */
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const [revealOpen, setRevealOpen] = useState(false);
  const [revealPending, setRevealPending] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  /** Coach message that offered Hint — bridge nests under that turn. */
  const revealForMessageIdRef = useRef<string | null>(null);

  const [nudges, setNudges] = useState<AmbientEntry[]>([]);
  const [coachMessages, setCoachMessages] = useState<CoachChatMessage[]>([]);
  /**
   * The thread read from the hot paths.
   *
   * `askCoach` is rebuilt whenever its deps change, and adding the whole
   * message list to them would rebuild it on every turn — including mid-send.
   * The ref is the transcript's stable door.
   */
  const coachMessagesRef = useRef<CoachChatMessage[]>([]);
  coachMessagesRef.current = coachMessages;
  /** Hand a failed run to the coach without being asked. Off by default. */
  const [forwardFailures, setForwardFailures] = useState(() => loadForwardFailures());
  const forwardFailuresRef = useRef(forwardFailures);
  forwardFailuresRef.current = forwardFailures;
  /** Thread the composer is inside, if any — narrows what the coach is told. */
  const threadRootIdRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [coachPhase, setCoachPhase] = useState<string | null>(null);
  const [ambientProvider, setAmbientProvider] = useState<string | null>(null);
  const [lastSkip, setLastSkip] = useState<string | null>(null);

  /** Element ids at the last analysed board, for the stroke-delta check. */
  const lastIdsRef = useRef<Set<string>>(new Set());
  /** Element ids after the last successful Review board send. */
  const lastReviewIdsRef = useRef<Set<string>>(new Set());
  const reviewTurnRef = useRef(0);
  /** Server-ack structure baseline for Phase 3 board_ops. */
  const lastStructureBaselineRef = useRef<StructureBaseline | null>(null);
  const lastPseudocodeHashRef = useRef<string | undefined>(undefined);
  /** Skeleton hash the server acknowledged — what a code delta is anchored to. */
  const lastSkeletonHashRef = useRef<string | undefined>(undefined);
  /**
   * The last test run, formatted for the model. Sent with every coach request
   * so "why did case 3 fail?" needs no copy-paste, and refreshed on every run
   * so the coach never argues from a stale result.
   */
  const lastTestReportRef = useRef<string | null>(null);
  /** Which problem set the open problem came from — every request carries it. */
  const datasetRef = useRef<string>(DEFAULT_DATASET);
  datasetRef.current = problem?.dataset ?? DEFAULT_DATASET;
  /**
   * True once the workspace holds work worth asking about keeping: edited
   * code, a drawn board, a coach exchange, or a test run. An untouched problem
   * skips the save-or-discard dialog entirely.
   */
  const dirtyRef = useRef(false);
  /** The code as loaded, so an untouched editor does not count as work. */
  const loadedSourceRef = useRef("");
  /**
   * Suspends the board autosave between "discard" and the next problem load.
   *
   * `finishAttempt` deletes `board.json` on the daemon, and the 3-second
   * autosave would otherwise write the still-mounted old scene straight back
   * over it — the student would discard their work and find it waiting.
   *
   * The coach thread has the same hazard and the same guard.
   */
  const boardSaveSuspendedRef = useRef(false);
  const agentSaveSuspendedRef = useRef(false);
  const coachRef = useRef<AmbientCoach | null>(null);
  // The recognizer can be swapped after mount; read it through a ref so the
  // ambient loop doesn't need to restart when it lands.
  const recognizerRef = useRef(recognizer);
  recognizerRef.current = recognizer;
  // Read through a ref for the same reason: otherwise every keystroke in the
  // pseudocode editor would tear down and restart the ambient loop.
  const pseudocodeRef = useRef(pseudocode);
  pseudocodeRef.current = pseudocode;

  /**
   * Coach open/close changes the canvas box (side panel or bottom sheet).
   * Nudge Excalidraw + our fit so the board fills the freed space.
   */
  // Desktop: coach docks beside the board and changes width — refit page to new hole.
  // Mobile: coach overlays; keep the template size (no vertical rescale).
  useEffect(() => {
    if (!problem || mobile) return;
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
      boardRef.current?.refitToViewport();
    }, 40);
    return () => window.clearTimeout(timer);
  }, [coachOpen, mobile, problem]);

  // Keep the dashed code frame tall enough for the Monaco solution.
  useEffect(() => {
    if (!problem) return;
    boardRef.current?.fitCodeToSource(pseudocode);
    if (pseudocode !== loadedSourceRef.current) dirtyRef.current = true;
  }, [problem, pseudocode]);

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

  const sceneApi = useCallback((): SceneApi | null => {
    const board = boardRef.current;
    if (!board) return null;
    return {
      getSceneElements: () => board.getElements(),
      updateScene: (scene) => board.setElements(scene.elements),
    };
  }, []);

  /** Paint only expanded drawings onto the coach lane. */
  const syncDrawingsToBoard = useCallback(
    (messages: CoachChatMessage[]) => {
      const board = boardRef.current;
      const api = sceneApi();
      if (!board || !api) return;
      const visible = visibleDrawings(messages);
      const visibleIds = new Set(visible.map((drawing) => drawing.program.id));
      for (const id of Array.from(
        new Set(
          messages
            .map((message) => message.drawing?.program.id)
            .filter((id): id is string => Boolean(id)),
        ),
      )) {
        if (!visibleIds.has(id)) removeViz(api, id);
      }
      for (const drawing of visible) {
        applyViz(
          api,
          (skeletons) => board.convert(skeletons, { regenerateIds: false }),
          drawing.program,
          drawing.frameIndex ?? 0,
        );
      }
    },
    [sceneApi],
  );

  /** Stage 1 of the ambient sampler: cheap, synchronous, runs every tick. */
  const probe = useCallback((): AmbientProbe => {
    const board = boardRef.current;
    if (!board) return { sceneHash: 0, newElements: 0, hasContent: false };
    const elements = board.getElements();
    const mine = studentElements(elements);
    const inkOps = board.getInkOpCount();
    let added = 0;
    for (const element of mine) {
      if (!lastIdsRef.current.has(element.id)) added += 1;
    }
    return {
      sceneHash: sceneFingerprint(elements, inkOps),
      newElements: added,
      hasContent: mine.length > 0 || inkOps > 0,
    };
  }, []);

  /** Stage 2: recognition, only after stage 1 said the board changed. */
  const capture = useCallback(async () => {
    const board = boardRef.current;
    if (!board) return { recognized_text: "" };
    const snapshot = await buildSnapshot(board, recognizerRef.current, {
      pseudocode: pseudocodeRef.current,
      structureBaseline: lastStructureBaselineRef.current,
      skeletonHash: await sha256Hex(skeletonOf(pseudocodeRef.current)),
      lastSkeletonHash: lastSkeletonHashRef.current,
      lastPseudocodeHash: lastPseudocodeHashRef.current,
    });
    lastIdsRef.current = snapshot.ids;
    return snapshot.board;
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      setSession(await client.getSession());
    } catch {
      setSession(null);
    }
  }, [client]);

  // Debounced board persistence — skip when scene + ink fingerprint is unchanged.
  const lastSavedHashRef = useRef<number | null>(null);
  /** Ink op count at the previous tick, for "is the hand still moving?". */
  const lastTickInkOpsRef = useRef(-1);
  /** Ticks deferred in a row because writing was still going on. */
  const deferredSavesRef = useRef(0);
  useEffect(() => {
    if (!problem) return;
    const timer = window.setInterval(() => {
      const board = boardRef.current;
      if (!board || boardSaveSuspendedRef.current) return;
      const elements = board.getElements();
      const inkOps = board.getInkOpCount();
      const hash = sceneFingerprint(elements, inkOps);
      if (lastSavedHashRef.current === hash) {
        lastTickInkOpsRef.current = inkOps;
        return;
      }

      /*
       * Not while they are writing.
       *
       * Saving walks every element and every ink point on the page and hands
       * the lot to `JSON.stringify` on the main thread — the board goes on the
       * wire, and the scratchpad goes to `localStorage`, which is a blocking
       * write. On a timer that cost lands wherever it lands, and every so often
       * that is under the nib: the stroke stops dead partway through a letter
       * and the next one feels like it is catching up. It reads as random, but
       * it is not — a long stroke takes longer, so the tick is likelier to
       * land inside an "e" or a "p" than inside an "i".
       *
       * So wait for a gap in the writing. The tip being down is the obvious
       * one; the op count still moving means the pen is between letters, which
       * is a gap far too short to spend on this. A ceiling keeps a long unbroken
       * burst from going unsaved indefinitely, and even a forced save waits for
       * the tip to come off the paper.
       */
      const stillWriting =
        lastTickInkOpsRef.current !== inkOps || board.isInking();
      lastTickInkOpsRef.current = inkOps;
      if (board.isInking() || (stillWriting && deferredSavesRef.current < 4)) {
        deferredSavesRef.current += 1;
        return;
      }
      deferredSavesRef.current = 0;

      if (isMdInk(problem)) {
        /*
         * Annotations autosave, the document does not.
         *
         * Same crash-insurance the scratchpad gets, and the same restraint:
         * nothing is written until something has actually been drawn, so
         * opening a document to read it never creates a library entry. Discard
         * on the way out undoes whatever these ticks committed.
         */
        if (mdInkPristineHashRef.current === hash) {
          lastSavedHashRef.current = hash;
          return;
        }
        const source = mdInkSourceRef.current;
        if (!source) return;
        try {
          const saved = saveMdInkDoc({
            id: mdInkDocIdRef.current ?? undefined,
            name: source.name,
            hash: source.hash,
            source: source.text,
            board: board.saveBoard(),
          });
          if (!mdInkDocIdRef.current) setMdInkDocId(saved.id);
          lastSavedHashRef.current = hash;
        } catch {
          // A full library is not worth interrupting a writing session for;
          // the explicit Save on the way out reports it properly.
        }
        return;
      }

      if (isScratchpad(problem)) {
        /*
         * Don't put an untouched notebook in the library.
         *
         * The first tick of a fresh scratchpad has nothing to save but the
         * blank template, and saving it anyway was how the library filled up
         * with empty notebooks nobody asked for — open the scratchpad, change
         * your mind, and three seconds later it is a permanent entry. There is
         * also nothing to protect: a crash here loses a blank page.
         */
        if (scratchPristineHashRef.current === hash) {
          lastSavedHashRef.current = hash;
          return;
        }
      }

      const blob = board.saveBoard();
      dirtyRef.current = true;
      if (isScratchpad(problem)) {
        try {
          const saved = saveScratchNotebook({
            id: scratchNotebookId ?? undefined,
            board: blob,
            agent: persistableCoachMessages(coachMessages),
            pageCount: Math.max(
              scratchPageCount,
              countScratchPages(blob.elements),
            ),
          });
          if (!scratchNotebookId) setScratchNotebookId(saved.id);
          lastSavedHashRef.current = hash;
        } catch (cause) {
          if (cause instanceof ScratchpadLibraryFullError) {
            scratchLibResumeRef.current = null;
            setScratchLibOpen(true);
          }
        }
        return;
      }
      void client.putBoard(problem.task_id, blob, problem.dataset).then(() => {
        lastSavedHashRef.current = hash;
      }).catch(() => {
        /* best-effort */
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [client, problem, scratchNotebookId, scratchPageCount, coachMessages]);

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
  }, [client, pairing]);

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

  const modeHasVision = useCallback(
    (modeName: string) =>
      capabilities?.modes.find((entry) => entry.mode === modeName)?.vision === true,
    [capabilities],
  );

  const syncSolution = useCallback(async () => {
    if (!problem || isLocalPad(problem)) return;
    await client.putSolution(problem.task_id, pseudocodeRef.current, problem.dataset);
  }, [client, problem]);

  /** App-side channel on every coach request: the last test run, as fact. */
  const appMessages = useCallback(
    () => (lastTestReportRef.current ? [lastTestReportRef.current] : undefined),
    [],
  );

  const pickProblem = useCallback(
    async (taskId: string, bank?: SearchOptions, opts?: { keepSessionNav?: boolean }) => {
      const offline = serverLinkRef.current !== "online";
      const datasetId = bank?.dataset ?? DEFAULT_DATASET;
      const fromBrowse = !problem;
      const switching = Boolean(problem);
      setActiveRegion("constraints");
      setBusy(offline ? "opening offline…" : "loading the workspace…");
      setError(null);
      setTests(null);
      setNudges([]);
      setCoachMessages([]);
      revealForMessageIdRef.current = null;
      lastReviewIdsRef.current = new Set();
      reviewTurnRef.current = 0;
      lastStructureBaselineRef.current = null;
      lastPseudocodeHashRef.current = undefined;
      lastSkeletonHashRef.current = undefined;
      lastTestReportRef.current = null;
      dirtyRef.current = false;
      boardSaveSuspendedRef.current = true;
      agentSaveSuspendedRef.current = true;
      setAttemptState(null);
      if (bank) setBankFilters(bank);
      if (!opts?.keepSessionNav) setNavigateBySession(false);
      if (fromBrowse) {
        setHoldBrowseOverlay(true);
        setBrowseMotion("busy");
      }
      if (switching) setSwitchMotion("busy");
      try {
        if (offline) {
          const { loadOfflinePack, offlineGetProblem } = await import("./util/offlineCorpus");
          const pack = await loadOfflinePack();
          const detail = pack ? offlineGetProblem(pack, taskId, datasetId) : null;
          if (!detail) {
            throw new Error(
              "Problem not in the offline pack — connect to download it (Settings → Server).",
            );
          }
          const source = ensureCodingRoom(detail.starter_code ?? "");

          if (fromBrowse) {
            setBrowseMotion("exit");
            await waitMs(slideDurationMs());
            setBrowseMotion("done");
            await waitMs(doneHoldMs());
          } else if (switching) {
            setSwitchMotion("done");
            await waitMs(doneHoldMs());
          }

          setPseudocode(source);
          loadedSourceRef.current = source;
          setBoardPreparing(true);
          setProblem(detail);

          const skeletons = buildProblemTemplate({
            taskId: detail.task_id,
            title: titleFromSlug(detail.task_id, detail.question_id),
            difficulty: detail.difficulty,
            tags: detail.tags,
            description: detail.problem_description,
            caseCount: detail.cases.length,
            dark: isDarkTheme(themeId),
          });
          lastSavedHashRef.current = null;
          boardRef.current?.seedTemplate(skeletons);
          boardRef.current?.applyThemeInk(themeId);
          boardRef.current?.stripCoachViz();
          boardRef.current?.fitCodeToSource(source);
          lastIdsRef.current = new Set();
          await boardRef.current?.waitForTemplate();
          await boardRef.current?.settleFitView();

          setBrowseMotion("idle");
          setSwitchMotion("idle");
          setHoldBrowseOverlay(false);
          setBoardPreparing(false);
          boardSaveSuspendedRef.current = false;
          agentSaveSuspendedRef.current = false;
          setEntering(true);
          window.setTimeout(() => setEntering(false), boardFadeMs() || 1);
          setCoachOpen(false);
          return;
        }

        // Materialize the workspace on the PC, then read back the redacted
        // statement for the board template. `resume` is whatever the last
        // visit chose to keep — the daemon already cleared what it did not.
        const loaded = await client.loadProblem(taskId, datasetId);
        setAttemptState(loaded.resume.attempt);
        const detail = await client.getProblem(taskId, datasetId);
        const fresh = ensureCodingRoom(detail.starter_code ?? "");
        let source = fresh;
        try {
          const disk = await client.getSolution(taskId, datasetId);
          if (disk.source.trim().length > 0) {
            source = ensureCodingRoom(resolveSolutionSource(fresh, disk.source));
            // Rewrite disk when we stripped stale ListNode/TreeNode leftovers.
            if (source.trim() !== disk.source.trim()) {
              try {
                await client.putSolution(taskId, source, datasetId);
              } catch {
                /* best-effort — editor still shows the corrected stub */
              }
            }
          }
        } catch {
          // Fresh load — starter_code is fine.
        }
        // A saved coach thread comes back with drawings attached to turns.
        const resumedMessages = restoreCoachMessages(loaded.resume.agent_messages);
        if (resumedMessages.length > 0) setCoachMessages(resumedMessages);

        if (fromBrowse) {
          // Ready: keep the spinner, slide the browser away under the blur.
          setBrowseMotion("exit");
          await waitMs(slideDurationMs());
          // Spinner → checkmark, then a short beat before the board.
          setBrowseMotion("done");
          await waitMs(doneHoldMs());
        } else if (switching) {
          setSwitchMotion("done");
          await waitMs(doneHoldMs());
        }

        setPseudocode(source);
        loadedSourceRef.current = source;
        // Mount the board under the overlay / blur, but keep it invisible until
        // fit settles — then crossfade so the viewport does not jump.
        setBoardPreparing(true);
        setProblem(detail);
        await refreshSession();

        const saved = loaded.resume.board as
          | {
              v?: number;
              elements?: unknown[];
              appState?: unknown;
              ink?: unknown[];
              files?: import("./canvas/BoardHandle").BoardBlob["files"];
            }
          | null;
        const hasSavedBoard =
          saved && saved.v === 1 && Array.isArray(saved.elements) && saved.elements.length > 0;

        let scaffolding:
          | { approach?: string; complexity?: string; walkthrough?: string }
          | undefined;
        if (!hasSavedBoard) {
          try {
            const scaffold = await client.scaffoldBoard(detail.task_id, datasetId);
            scaffolding = {
              approach: scaffold.approach || undefined,
              complexity: scaffold.complexity || undefined,
              walkthrough: scaffold.walkthrough || undefined,
            };
          } catch {
            // LLM optional — fall back to generic HINTS.
          }
        }

        const skeletons = buildProblemTemplate({
          taskId: detail.task_id,
          title: titleFromSlug(detail.task_id, detail.question_id),
          difficulty: detail.difficulty,
          tags: detail.tags,
          description: detail.problem_description,
          caseCount: detail.cases.length,
          dark: isDarkTheme(themeId),
          scaffolding,
        });

        // A saved layout is restored over the fresh template; otherwise seed
        // the template alone. Persisted boards can carry old region geometry,
        // so `restoreBoard` heals them against the current skeletons.
        lastSavedHashRef.current = null;
        if (hasSavedBoard && saved?.elements) {
          boardRef.current?.restoreBoard(saved.elements, saved.appState, {
            skeletons,
            ink: Array.isArray(saved.ink) ? (saved.ink as import("./canvas/rasterInk").InkOp[]) : [],
            files: saved.files,
          });
        } else {
          boardRef.current?.seedTemplate(skeletons);
        }
        // Restored boards keep ink from whatever theme they were saved under —
        // recolor to the current Appearance choice. Then drop stale coach viz
        // and re-apply only expanded drawings from the chat transcript.
        boardRef.current?.applyThemeInk(themeId);
        boardRef.current?.stripCoachViz();
        boardRef.current?.fitCodeToSource(source);
        lastIdsRef.current = new Set();

        // Wait until every dashed region frame is in the scene before fitting
        // and revealing — otherwise the loading checkmark races an empty board.
        await boardRef.current?.waitForTemplate();
        await boardRef.current?.settleFitView();
        syncDrawingsToBoard(resumedMessages);
        if (hasSavedBoard && saved && Array.isArray(saved.ink)) {
          boardRef.current?.setInkOps(saved.ink as import("./canvas/rasterInk").InkOp[]);
        }

        setBrowseMotion("idle");
        setSwitchMotion("idle");
        setHoldBrowseOverlay(false);
        setBoardPreparing(false);
        // The new board is mounted and fitted; autosave may write again.
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setEntering(true);
        window.setTimeout(() => {
          setEntering(false);
        }, boardFadeMs() || 1);
      } catch (cause) {
        setError(messageOf(cause));
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setHoldBrowseOverlay(false);
        setBoardPreparing(false);
        if (fromBrowse) setBrowseMotion("idle");
        setSwitchMotion("idle");
      } finally {
        setBusy(null);
      }
    },
    [client, themeId, problem, refreshSession, syncDrawingsToBoard],
  );

  const openScratchpad = useCallback(
    async (opts?: { notebookId?: string | null; fresh?: boolean }) => {
      if (busy !== null) return;
      if (opts?.fresh && !opts.notebookId && scratchLibraryCount() >= SCRATCHPAD_LIBRARY_LIMIT) {
        scratchLibResumeRef.current = () => {
          void openScratchpad({ fresh: true });
        };
        setScratchLibOpen(true);
        return;
      }
      setBusy("opening scratchpad…");
      setError(null);
      setTests(null);
      setNudges([]);
      setCoachMessages([]);
      setScratchPageIndex(0);
      setScratchEntryOpen(false);
      boardSaveSuspendedRef.current = true;
      agentSaveSuspendedRef.current = true;
      try {
        migrateLegacyScratchpad(countScratchPages);
        setBoardPreparing(true);
        setProblem(SCRATCHPAD_PROBLEM);
        setPseudocode("");
        loadedSourceRef.current = "";
        lastSavedHashRef.current = null;

        const dark = isDarkTheme(themeId);
        let restored = false;
        let notebookId: string | null = opts?.notebookId ?? null;

        if (!opts?.fresh && notebookId) {
          const notebook = getScratchNotebook(notebookId);
          if (notebook) {
            const pages = Math.min(
              SCRATCHPAD_PAGE_LIMIT,
              Math.max(1, notebook.pageCount, countScratchPages(notebook.board.elements)),
            );
            const skeletons = buildScratchpadTemplate(pages, dark);
            boardRef.current?.restoreBoard(notebook.board.elements, notebook.board.appState, {
              skeletons,
              ink: Array.isArray(notebook.board.ink) ? notebook.board.ink : [],
              files: notebook.board.files,
            });
            setScratchPageCount(pages);
            setScratchNotebookId(notebook.id);
            if (notebook.agent.length > 0) {
              setCoachMessages(restoreCoachMessages(notebook.agent));
            }
            restored = true;
          }
        }

        if (!restored) {
          const skeletons = buildScratchpadTemplate(1, dark);
          boardRef.current?.seedTemplate(skeletons);
          setScratchPageCount(1);
          setScratchNotebookId(null);
          notebookId = null;
        }

        // A blank notebook has no baseline, and that is the point: discarding
        // one means deleting whatever the autosave went on to create for it.
        scratchBaselineRef.current = {
          id: restored ? notebookId : null,
          entry: restored && notebookId ? getScratchNotebook(notebookId) : null,
        };

        boardRef.current?.applyThemeInk(themeId);
        boardRef.current?.stripCoachViz();
        lastIdsRef.current = new Set();
        await boardRef.current?.waitForTemplate();
        await boardRef.current?.settleFitView();
        // Ink layer may have mounted after the first restore — re-apply saved strokes.
        if (restored && notebookId) {
          const notebook = getScratchNotebook(notebookId);
          if (notebook && Array.isArray(notebook.board.ink)) {
            boardRef.current?.setInkOps(notebook.board.ink);
          }
        }

        // Taken after the template and any restored ink have landed, so it is
        // the notebook as the writer first sees it. Anything that moves this
        // number from here is something they did.
        {
          const board = boardRef.current;
          scratchPristineHashRef.current = board
            ? sceneFingerprint(board.getElements(), board.getInkOpCount())
            : null;
        }

        setBoardPreparing(false);
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setEntering(true);
        window.setTimeout(() => setEntering(false), boardFadeMs() || 1);
        setCoachOpen(false);
      } catch (cause) {
        setError(messageOf(cause));
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setBoardPreparing(false);
      } finally {
        setBusy(null);
      }
    },
    [busy, themeId],
  );

  /**
   * Open a markdown document to annotate.
   *
   * Either a file the writer just picked, or a library entry being reopened —
   * both land here with the same three things: the text, its name, and its
   * hash. Any annotation set already drawn over that exact text is restored
   * with it, so picking the same file twice picks up where it left off.
   */
  const openMdInk = useCallback(
    async (input: { name: string; text: string; docId?: string | null }) => {
      if (busy !== null) return;
      setBusy("opening document…");
      setError(null);
      setTests(null);
      setNudges([]);
      setCoachMessages([]);
      setMdInkEntryOpen(false);
      boardSaveSuspendedRef.current = true;
      agentSaveSuspendedRef.current = true;

      try {
        const hash = hashMarkdown(input.text);
        const existing = input.docId
          ? getMdInkDoc(input.docId)
          : findMdInkDocByHash(hash);

        /*
         * Say so when the file has moved on since it was last annotated.
         *
         * Without this the writer gets a blank page and no explanation, which
         * from the outside is indistinguishable from having lost their work.
         * The old set is not applied — its marks belong to lines that have
         * shifted or gone — but it is still in the library under Recent, so
         * naming it is enough to make the situation legible.
         */
        const stale = existing ? null : findStaleMdInkDoc(input.name, hash);

        setBoardPreparing(true);
        setProblem(MD_INK_PROBLEM);
        setPseudocode("");
        loadedSourceRef.current = "";
        lastSavedHashRef.current = null;
        setMdInkSource({ name: input.name, text: input.text, hash });
        setMdInkHeight(null);

        const dark = isDarkTheme(themeId);
        // The real height arrives from the document's own measure a frame or
        // two later; start at the floor so the frame is never zero-sized.
        const savedInk = Array.isArray(existing?.board.ink) ? existing.board.ink : [];
        // Size the column to this screen so width-fit keeps type Obsidian-readable
        // (a fixed 760 on a phone was ~8px body). Inked restores from a wider
        // tablet may see marks drift — the width is part of the annotate
        // contract; storing it per document is the lasting fix.
        const pageWidth = mdInkPageWidthForViewport(
          typeof window !== "undefined" ? window.innerWidth : MD_INK_PAGE_W,
        );
        setMdInkPageWidth(pageWidth);
        const skeletons = buildMdInkTemplate(mdInkPageHeight(null), dark, pageWidth);

        if (existing) {
          boardRef.current?.restoreBoard(existing.board.elements, existing.board.appState, {
            skeletons,
            ink: savedInk,
            files: existing.board.files,
          });
          // Restore kept the saved frame width — rewrite to this viewport so
          // fit does not shrink the type. Ink stays; marks may drift if the
          // page was authored wider.
          const live = boardRef.current?.getElements() ?? [];
          boardRef.current?.setElements(
            live.map((el) => {
              const meta = (el as { customData?: { lcMdInkFrame?: boolean } }).customData;
              if (!meta?.lcMdInkFrame) return el;
              return {
                ...(el as object),
                width: pageWidth,
                locked: true,
                versionNonce: Math.random() * 2 ** 31,
              };
            }),
          );
          setMdInkDocId(existing.id);
        } else {
          boardRef.current?.seedTemplate(skeletons);
          setMdInkDocId(null);
        }

        mdInkBaselineRef.current = {
          id: existing?.id ?? null,
          entry: existing,
        };

        boardRef.current?.applyThemeInk(themeId);
        boardRef.current?.stripCoachViz();
        lastIdsRef.current = new Set();
        await boardRef.current?.waitForTemplate();
        await boardRef.current?.settleFitView();
        // Same late-mount dance as the scratchpad: the ink layer may only exist
        // after the first restore, so the strokes go on again once it does.
        if (existing && Array.isArray(existing.board.ink)) {
          boardRef.current?.setInkOps(existing.board.ink);
        }

        {
          const board = boardRef.current;
          mdInkPristineHashRef.current = board
            ? sceneFingerprint(board.getElements(), board.getInkOpCount())
            : null;
        }

        setBoardPreparing(false);
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setEntering(true);
        window.setTimeout(() => setEntering(false), boardFadeMs() || 1);
        setCoachOpen(false);
        if (stale) {
          setNotice(
            `“${input.name}” has changed since it was annotated on ` +
              `${new Date(stale.updatedAt).toLocaleDateString()} — starting a fresh set. ` +
              `The old one is still under Recent.`,
          );
        }
      } catch (cause) {
        setError(messageOf(cause));
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setBoardPreparing(false);
      } finally {
        setBusy(null);
      }
    },
    [busy, themeId],
  );

  /**
   * Write the annotation set out as a file the writer can keep.
   *
   * Annotations live in this browser's storage, which is fine right up until
   * the tablet is not the device they have. The sidecar is the way out.
   */
  const exportMdInkAnnotations = useCallback(() => {
    const board = boardRef.current;
    const source = mdInkSourceRef.current;
    if (!board || !source) return;
    exportMdInkSidecar(
      buildMdInkSidecar({
        sourceName: source.name,
        contentHash: source.hash,
        board: board.saveBoard(),
      }),
    );
    setNotice(`Exported annotations for “${source.name}”.`);
  }, []);

  /**
   * Read a sidecar back in, over the document it was drawn on.
   *
   * Refused when the sidecar belongs to different text: its marks were placed
   * against lines that are not the ones on screen, and putting them down anyway
   * would scatter ink across the wrong words with no way back.
   */
  const importMdInkAnnotations = useCallback(async () => {
    const source = mdInkSourceRef.current;
    if (!source) {
      setError("Open a markdown file first, then import its annotations.");
      return;
    }
    try {
      const picked = await pickSidecarFile();
      if (!picked) return;
      const sidecar = readMdInkSidecar(picked.text);
      if (!sidecar) {
        setError(`“${picked.name}” is not an annotation sidecar.`);
        return;
      }
      if (sidecar.contentHash !== source.hash) {
        setError(
          `Those annotations were drawn over a different version of ` +
            `“${sidecar.sourceName}” — they would not line up with this text.`,
        );
        return;
      }
      boardRef.current?.restoreBoard(sidecar.board.elements, sidecar.board.appState, {
        skeletons: buildMdInkTemplate(
          mdInkPageHeight(mdInkHeight),
          isDarkTheme(themeId),
          mdInkFrameWidthFromElements(
            sidecar.board.elements as {
              width?: number;
              customData?: { lcMdInkFrame?: boolean } | null;
            }[],
          ) ?? mdInkPageWidth,
        ),
        ink: Array.isArray(sidecar.board.ink) ? sidecar.board.ink : [],
        files: sidecar.board.files,
      });
      if (Array.isArray(sidecar.board.ink)) boardRef.current?.setInkOps(sidecar.board.ink);
      setNotice(`Imported annotations for “${sidecar.sourceName}”.`);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [mdInkHeight, themeId]);

  /** Pick a markdown file from disk and open it. */
  const pickAndOpenMdInk = useCallback(async () => {
    if (busy !== null) return;
    try {
      const picked = await pickMarkdownFile();
      if (!picked) return;
      await openMdInk({ name: picked.name, text: picked.source });
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [busy, openMdInk]);


  const addScratchPage = useCallback(() => {
    if (!isScratchpad(problem)) return;
    if (scratchPageCount >= SCRATCHPAD_PAGE_LIMIT) {
      setNotice(`Scratchpad notebooks cap at ${SCRATCHPAD_PAGE_LIMIT} pages.`);
      return;
    }
    const nextIndex = scratchPageCount;
    const skeletons = buildScratchPageSkeletons(nextIndex, isDarkTheme(themeId));
    const index = boardRef.current?.appendScratchPage(skeletons) ?? nextIndex;
    setScratchPageCount(index + 1);
    setScratchPageIndex(index);
    dirtyRef.current = true;
  }, [problem, scratchPageCount, themeId]);

  /** Session queue after Start / Random; otherwise the filtered problem bank. */
  const stepProblem = useCallback(
    async (delta: number) => {
      if (!problem || busy !== null) return;
      // Queue entries are `dataset/task_id`, since the same slug can be in
      // several problem sets at once.
      const queue = session?.queue ?? [];
      const queueIndex = queue.indexOf(problem.key);
      if (navigateBySession && queue.length > 0 && queueIndex >= 0) {
        const next = queue[queueIndex + delta];
        if (next) {
          const [nextDataset, nextTask] = splitProblemKey(next);
          void pickProblem(nextTask, { ...bankFilters, dataset: nextDataset }, { keepSessionNav: true });
        }
        return;
      }
      try {
        if (serverLinkRef.current !== "online") {
          const { loadOfflinePack, offlineAdjacent } = await import("./util/offlineCorpus");
          const pack = await loadOfflinePack();
          if (!pack) return;
          const adjacent = offlineAdjacent(pack, problem.task_id, {
            dataset: problem.dataset,
            q: bankFilters.q,
            difficulty: bankFilters.difficulty,
            tag: bankFilters.tag,
            sort: bankFilters.sort,
          });
          const next = delta < 0 ? adjacent.prev : adjacent.next;
          if (next) void pickProblem(next, { ...bankFilters, dataset: problem.dataset });
          return;
        }
        const adjacent = await client.adjacentProblems(problem.task_id, {
          ...bankFilters,
          dataset: problem.dataset,
        });
        const next = delta < 0 ? adjacent.prev : adjacent.next;
        if (next) void pickProblem(next, { ...bankFilters, dataset: problem.dataset });
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [problem, busy, session, navigateBySession, client, bankFilters, pickProblem],
  );

  useEffect(() => {
    if (!problem) {
      setCanStepPrev(false);
      setCanStepNext(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const queue = session?.queue ?? [];
      const queueIndex = queue.indexOf(problem.key);
      if (navigateBySession && queue.length > 0 && queueIndex >= 0) {
        if (!cancelled) {
          setCanStepPrev(queueIndex > 0);
          setCanStepNext(queueIndex < queue.length - 1);
        }
        return;
      }
      try {
        if (serverLinkRef.current !== "online") {
          const { loadOfflinePack, offlineAdjacent } = await import("./util/offlineCorpus");
          const pack = await loadOfflinePack();
          if (!cancelled) {
            if (!pack) {
              setCanStepPrev(false);
              setCanStepNext(false);
            } else {
              const adjacent = offlineAdjacent(pack, problem.task_id, {
                dataset: problem.dataset,
                q: bankFilters.q,
                difficulty: bankFilters.difficulty,
                tag: bankFilters.tag,
                sort: bankFilters.sort,
              });
              setCanStepPrev(Boolean(adjacent.prev));
              setCanStepNext(Boolean(adjacent.next));
            }
          }
          return;
        }
        const adjacent = await client.adjacentProblems(problem.task_id, {
          ...bankFilters,
          dataset: problem.dataset,
        });
        if (!cancelled) {
          setCanStepPrev(Boolean(adjacent.prev));
          setCanStepNext(Boolean(adjacent.next));
        }
      } catch {
        if (!cancelled) {
          setCanStepPrev(false);
          setCanStepNext(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [problem, session, navigateBySession, bankFilters, client]);

  // The coach socket's lifecycle.
  //
  // It carries two things now: the ambient loop (still gated behind
  // `AMBIENT_ENABLED`, still on its own timer) and interactive runs. Which of
  // those is wanted decides whether the socket opens at all — with ambient off
  // and `ws_runs` off, this stays exactly as it was: no connection, no timer.
  useEffect(() => {
    if (!problem) return;
    const ambient = AMBIENT_ENABLED && mode === "ambient";
    if (!ambient && !coachFlags.ws_runs) return;

    const onFrame = (frame: ServerFrame) => {
      switch (frame.type) {
        case "ready":
          setAmbientProvider(frame.provider);
          break;
        case "thinking":
          setThinking(true);
          break;
        case "nudge":
          setThinking(false);
          setNudges((current) => [{ ...frame, at: Date.now() }, ...current].slice(0, 12));
          setCoachMessages((current) => [
            ...current,
            {
              id: `nudge-${Date.now()}`,
              role: "assistant",
              content: frame.nudge,
              at: Date.now(),
            },
          ]);
          setCoachOpen(true);
          break;
        case "skipped":
          setThinking(false);
          setLastSkip(frame.reason);
          break;
        case "error":
          setThinking(false);
          setError(frame.message);
          break;
      }
    };

    const coach = new AmbientCoach(pairing, {
      onFrame,
      onCapturing: () => setThinking(true),
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onError: (message) => setError(message),
      onSkip: (reason) => setLastSkip(reason),
    });
    coachRef.current = coach;
    if (ambient) coach.start(problem.task_id, probe, capture);
    else coach.connect(problem.task_id);

    return () => {
      coach.stop();
      coachRef.current = null;
      setConnected(false);
      setThinking(false);
    };
  }, [mode, problem, pairing, probe, capture, coachFlags.ws_runs]);

  /**
   * Open an assistant turn to fill in while the coach works.
   *
   * The turn exists from the moment the request leaves, so the stages have
   * somewhere to land and the student can see the work is theirs — not a
   * spinner that could belong to anything.
   */
  const beginCoachTurn = useCallback((): string => {
    const id = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dirtyRef.current = true;
    setCoachMessages((current) => [
      ...current,
      { id, role: "assistant", content: "", at: Date.now(), pending: true, processEvents: [] },
    ]);
    return id;
  }, []);

  const appendProcessEvent = useCallback((messageId: string, event: CoachProcessEvent) => {
    setCoachMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? { ...message, processEvents: [...(message.processEvents ?? []), event] }
          : message,
      ),
    );
  }, []);

  /**
   * Finish a placeholder turn.
   *
   * `produced` replaces it in place, keeping its position in the thread — one
   * message for a review or an answer, several when Draw returns more than one
   * diagram. `null` drops it: the failure is already on the error banner, and
   * an empty turn left behind would read as the coach answering with nothing.
   */
  const finishCoachTurn = useCallback(
    (
      messageId: string,
      produced: Array<Partial<CoachChatMessage> & { content: string }> | null,
    ) => {
      setCoachMessages((current) => {
        const index = current.findIndex((message) => message.id === messageId);
        if (index < 0) return current;
        const placeholder = current[index];
        const rest = [...current.slice(0, index), ...current.slice(index + 1)];
        if (!produced || produced.length === 0) return rest;

        const built: CoachChatMessage[] = produced.map((part, offset) => ({
          id: offset === 0 ? placeholder.id : `${placeholder.id}-${offset}`,
          role: "assistant",
          at: Date.now(),
          // The process block belongs to the first turn only — repeating it
          // under every diagram would bury them.
          ...(offset === 0 ? { processEvents: placeholder.processEvents } : {}),
          ...part,
        }));
        const next = [...current.slice(0, index), ...built, ...current.slice(index + 1)];
        return built.some((message) => message.drawing?.expanded)
          ? enforceVisibleDrawingCap(next, MAX_VISIBLE_DRAWINGS)
          : next;
      });
    },
    [],
  );

  /**
   * Run one coach job, over the socket when it is available and blocking HTTP
   * when it is not.
   *
   * The payloads are identical either way — the daemon's `run` frame takes the
   * same body its `POST /coach/*` route does — so `http` is a straight
   * fallback, not a second code path with its own quirks.
   */
  const runCoachJob = useCallback(
    async <T,>(
      action: RunAction,
      payload: Record<string, unknown>,
      messageId: string | null,
      http: () => Promise<T>,
    ): Promise<T> => {
      const socket = coachRef.current;
      if (!coachFlags.ws_runs || !socket) return http();
      try {
        return await socket.run<T>(action, payload, {
          onProcess: (event) => {
            if (messageId && coachFlags.process_events_ui) appendProcessEvent(messageId, event);
          },
        });
      } catch (cause) {
        // A daemon that predates run frames, or a socket that dropped, should
        // cost the student a retry at worst — not the answer.
        if (isSocketRunUnavailable(cause)) return http();
        throw cause;
      }
    },
    [coachFlags.ws_runs, coachFlags.process_events_ui, appendProcessEvent],
  );

  const pushCoachMessage = useCallback(
    (
      role: CoachChatMessage["role"],
      content: string,
      extra?: Pick<
        CoachChatMessage,
        | "review"
        | "attachments"
        | "drawing"
        | "bridge"
        | "bridgePending"
        | "bridgeError"
        | "flags"
      >,
    ) => {
      dirtyRef.current = true;
      setCoachMessages((current) => {
        let next: CoachChatMessage[] = [
          ...current,
          {
            id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            role,
            content,
            at: Date.now(),
            ...extra,
          },
        ];
        if (extra?.drawing?.expanded) {
          next = enforceVisibleDrawingCap(next, MAX_VISIBLE_DRAWINGS);
        }
        return next;
      });
    },
    [],
  );

  const submitForReview = useCallback(async (
    studentNote?: string,
    includeBoard = true,
    attachments?: CoachChatMessage["attachments"],
    /** Lazy composer: review the board only — code dock is filled separately. */
    layoutOnly = false,
  ) => {
    const board = boardRef.current;
    if (!board || !problem) return;
    setBusy("asking the coach…");
    setError(null);
    setNotice(null);
    setCoachOpen(true);

    const note = studentNote?.trim() ?? "";
    const topic =
      note.length > 0
        ? note.length > 48
          ? `${note.slice(0, 48)}…`
          : note
        : includeBoard
          ? "your board"
          : "your question";
    // Timed guesses at the phases, for the path that has nothing better. When
    // runs go over the socket the real stage boundaries arrive instead, and
    // guessing over the top of them would contradict them.
    const phaseTimers: number[] = [];
    if (!coachFlags.ws_runs) {
      const phases = includeBoard
        ? [
            note ? "Reading your message…" : "Reading the request…",
            "Loading your layouts…",
            `Thinking about ${topic}…`,
            "Preparing response…",
          ]
        : ["Reading your message…", `Thinking about ${topic}…`, "Preparing response…"];
      let delay = 0;
      for (const label of phases) {
        const id = window.setTimeout(() => setCoachPhase(label), delay);
        phaseTimers.push(id);
        delay += label.startsWith("Thinking") ? 2200 : 900;
      }
      setCoachPhase(phases[0]);
    } else {
      setCoachPhase(`Thinking about ${topic}…`);
    }

    const turnId = beginCoachTurn();
    let finished = false;
    try {
      await syncSolution();
      let payload;
      let capturedIds: Set<string> | null = null;
      if (includeBoard) {
        const snapshot = await buildSnapshot(board, recognizerRef.current, {
          pseudocode: pseudocodeRef.current,
          previousIds: lastReviewIdsRef.current,
          turnIndex: reviewTurnRef.current,
          includePng: modeHasVision("review"),
          structureBaseline: lastStructureBaselineRef.current,
          skeletonHash: await sha256Hex(skeletonOf(pseudocodeRef.current)),
          lastSkeletonHash: lastSkeletonHashRef.current,
          lastPseudocodeHash: lastPseudocodeHashRef.current,
        });
        if (note) {
          snapshot.board.recognized_text = `Student asks:\n${note}\n\n${snapshot.board.recognized_text ?? ""}`;
        }
        // Recognized text is not the only evidence of work: shapes, stamps, pen
        // ink, and (with a vision model) a PNG of the handwriting all count.
        const drawn =
          studentAuthoredElements(board.getElements()).length > 0 || board.hasRasterInk();
        const legible =
          snapshot.board.recognized_text.trim().length > 0 || pseudocodeRef.current.trim().length > 0;
        const pictured = snapshot.hasHandwriting && Boolean(snapshot.board.png);
        if (!legible && !drawn && !pictured) {
          setError("nothing on the board yet — sketch or type an approach, then ask the coach");
          return;
        }
        if (!legible && !pictured && recognizerRef.current.name === "none") {
          setNotice(
            "handwriting isn't recognized in the browser build — sending the shapes and layout you drew; type with the text tool if the coach misreads you",
          );
        }
        payload = snapshot.board;
        capturedIds = snapshot.ids;
      } else {
        if (!note) {
          setError("type a question, or turn on Review");
          return;
        }
        payload = {
          recognized_text: `Student asks:\n${note}`,
          pseudocode: pseudocodeRef.current.trim() || undefined,
          turn_index: reviewTurnRef.current,
        };
      }
      // `POST /coach/review` flattens the board into the request body, so the
      // run payload does the same — the daemon reads one struct either way.
      const askForReview = (board: typeof payload) =>
        runCoachJob<ReviewResponse>(
          "review",
          {
            task_id: problem.task_id,
            dataset: problem.dataset,
            layout_only: layoutOnly,
            ...board,
            app_messages: appMessages(),
          },
          turnId,
          () =>
            client.review(
              problem.task_id,
              { ...board, app_messages: appMessages() },
              problem.dataset,
              { layoutOnly },
            ),
        );

      let result: ReviewResponse;
      try {
        result = await askForReview(payload);
      } catch (cause) {
        // The picture is the first thing to give up: a board too big to buffer,
        // or a local VLM that hangs on the PNG, must not cost the whole review.
        const hasPng = "png" in payload && Boolean(payload.png);
        if (!hasPng || (!isBodyLimitError(cause) && !isLlmTimeoutError(cause))) throw cause;
        const { png: _png, ...withoutPng } = payload;
        result = await askForReview(withoutPng);
        setNotice(
          isLlmTimeoutError(cause)
            ? "the board image timed out at the model — the coach reviewed your text and layout without it"
            : "the board image was too large to send — the coach reviewed your text and layout without it",
        );
      }
      // One structured card in the thread — do not also push a prose duplicate.
      // Attachments show what the coach saw (same layouts as the user turn).
      finished = true;
      finishCoachTurn(turnId, [
        {
          content: "",
          review: result,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        },
      ]);
      // Baseline advances only on success — a failed review must not consume it.
      if (capturedIds) {
        lastReviewIdsRef.current = capturedIds;
        reviewTurnRef.current += 1;
        lastStructureBaselineRef.current = structureBaselineFromBoard(board.getElements());
        lastPseudocodeHashRef.current = await sha256Hex(pseudocodeRef.current);
        lastSkeletonHashRef.current = await sha256Hex(skeletonOf(pseudocodeRef.current));
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      // Every early return above — an empty board, a missing question — lands
      // here too, and none of them should leave a turn waiting forever.
      if (!finished) finishCoachTurn(turnId, null);
      for (const id of phaseTimers) window.clearTimeout(id);
      setCoachPhase(null);
      setBusy(null);
    }
  }, [
    client,
    problem,
    syncSolution,
    modeHasVision,
    appMessages,
    coachFlags.ws_runs,
    beginCoachTurn,
    finishCoachTurn,
    runCoachJob,
  ]);

  /**
   * Look at each diagram after the board rendered it, and take one correction.
   *
   * This runs *after* the turn is finished, deliberately: the diagram the
   * student asked for is already on the board and already theirs to read. The
   * check is an improvement pass, so a slow or failing one must not hold up
   * what already works.
   */
  const reviewDrawings = useCallback(
    async (drawables: VizProgram[], ask: string) => {
      const board = boardRef.current;
      if (!board || !problem || !coachFlags.draw_review_enabled) return;
      for (const program of drawables) {
        try {
          const png = await board.exportVizPng(program.id);
          // No pixels means the group is not on the board — collapsed, capped
          // out, or replaced. Nothing to look at.
          if (!png) continue;
          const verdict = await runCoachJob<DrawReviewEnvelope>(
            "draw_review",
            { task_id: problem.task_id, dataset: problem.dataset, program, png, ask },
            null,
            () => client.drawReview(problem.task_id, program, png, ask, problem.dataset),
          );
          const fixed = verdict.program ? parseVizProgram(verdict.program) : null;
          if (!fixed) continue;
          // The replacement keeps the program id, so it lands on top of the
          // diagram it is fixing rather than beside it.
          setCoachMessages((current) => {
            const next = current.map((message) =>
              message.drawing?.program.id === fixed.id
                ? { ...message, drawing: { ...message.drawing, program: fixed, frameIndex: 0 } }
                : message,
            );
            queueMicrotask(() => syncDrawingsToBoard(next));
            return next;
          });
          pushCoachMessage(
            "assistant",
            `Redrew that diagram — ${verdict.issues[0] ?? verdict.fix_hint}`,
          );
        } catch {
          // Best-effort by design: the diagram on the board already passed the
          // schema gate, which is the check with teeth.
        }
      }
    },
    [
      client,
      problem,
      coachFlags.draw_review_enabled,
      runCoachJob,
      syncDrawingsToBoard,
      pushCoachMessage,
    ],
  );

  const askForDiagram = useCallback(async (ask = "") => {
    const board = boardRef.current;
    if (!board || !problem) return;
    setBusy("drawing…");
    setError(null);
    setCoachOpen(true);
    const turnId = beginCoachTurn();
    let finished = false;
    try {
      await syncSolution();
      const snapshot = await buildSnapshot(board, recognizerRef.current, {
        pseudocode: pseudocodeRef.current,
        includePng: modeHasVision("viz"),
      });
      const vizBoard = { ...snapshot.board, app_messages: appMessages() };
      const envelope = await runCoachJob<VizEnvelope>(
        "viz",
        { task_id: problem.task_id, dataset: problem.dataset, board: vizBoard, ask },
        turnId,
        () => client.viz(problem.task_id, vizBoard, ask, problem.dataset),
      );
      const drawables = envelope.programs
        .map(parseVizProgram)
        .filter((candidate): candidate is VizProgram => candidate !== null)
        .slice(0, MAX_VISIBLE_DRAWINGS);

      if (drawables.length > 0) {
        dirtyRef.current = true;
        // Coach ink lives on the agent page — jump there on mobile so drawings
        // aren't parked invisible on Walkthrough / Scratch.
        if (mobile) setActiveRegion("agent");
        finished = true;
        finishCoachTurn(
          turnId,
          drawables.map((drawable, index) => ({
            content:
              drawables.length === 1
                ? "Drew a diagram on the board."
                : `Drew diagram ${index + 1} of ${drawables.length} on the board.`,
            drawing: withNewDrawing(drawable),
          })),
        );
        setCoachMessages((current) => {
          queueMicrotask(() => syncDrawingsToBoard(current));
          return current;
        });
        void reviewDrawings(drawables, ask);
      }

      const api = sceneApi();

      for (const annotation of envelope.annotations ?? []) {
        if (!api) break;
        applyAnnotation(api, (skeletons) => board.convert(skeletons), annotation, renderAnnotation);
      }

      for (const [index, highlight] of (envelope.highlights ?? []).entries()) {
        if (!api) break;
        applyHighlight(
          api,
          (skeletons) => board.convert(skeletons),
          highlight,
          index,
          (hl, elements, i) =>
            renderHighlight(hl, elements as import("./canvas/capture").SceneElementLike[], i),
        );
      }

      for (const citation of envelope.citations ?? []) {
        pushCoachMessage(
          "assistant",
          `Case ${citation.case_number}:\n${citation.input.trim()}\n→ ${citation.expected.trim()}\n\n${citation.why}`,
        );
      }

      for (const reason of envelope.rejected ?? []) {
        pushCoachMessage("assistant", reason);
      }

      if (
        drawables.length === 0 &&
        (envelope.annotations?.length ?? 0) === 0 &&
        (envelope.citations?.length ?? 0) === 0 &&
        (envelope.highlights?.length ?? 0) === 0
      ) {
        if (envelope.message?.trim()) {
          finished = true;
          finishCoachTurn(turnId, [{ content: envelope.message.trim() }]);
        } else {
          setError(
            envelope.rejected?.[0] ??
              "the coach didn't produce a diagram — its model may not support tool calling",
          );
        }
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (!finished) finishCoachTurn(turnId, null);
      setBusy(null);
    }
  }, [
    client,
    problem,
    syncSolution,
    modeHasVision,
    sceneApi,
    appMessages,
    syncDrawingsToBoard,
    mobile,
    beginCoachTurn,
    finishCoachTurn,
    runCoachJob,
    pushCoachMessage,
    reviewDrawings,
  ]);

  const applyFilledCode = useCallback(
    async (filled: string, note: string) => {
      if (!problem) return;
      /*
       * Repair the import the model forgot before it reaches the editor.
       *
       * Models answer these in the 3.5 idiom — `List[int]` — because that is
       * what the training data looks like, and often omit the import. On 3.12
       * that is `NameError` at import time: the tests do not fail, they never
       * start. The prompt asks for builtin generics; this is the net under it.
       */
      const next = ensureTypingImports(filled.trim());
      if (!next) return;
      setPseudocode(next);
      pseudocodeRef.current = next;
      dirtyRef.current = true;
      try {
        await client.putSolution(problem.task_id, next, problem.dataset);
        setNotice(note.trim() || "Lazy fill applied to solution.py");
        pushCoachMessage("assistant", note.trim() || "Filled the parts your board already justified.");
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [client, problem, pushCoachMessage],
  );

  const askCoach = useCallback(
    async (question: string) => {
      const note = question.trim();
      if (!problem || !note) {
        setError("type a question, or turn on Ask");
        return;
      }
      setBusy("asking…");
      setError(null);
      setNotice(null);
      setCoachOpen(true);
      setCoachPhase("Thinking…");
      const turnId = beginCoachTurn();
      let finished = false;
      try {
        await syncSolution();
        /*
         * Carry the conversation into the prompt.
         *
         * `/coach/ask` builds from the problem, the code and the question, so
         * without this every turn arrives as the first one — which is why a
         * shorthand reference to something two answers ago used to be answered
         * as if it had never been said. The transcript is assembled from the
         * turns already on screen, and from inside a thread it is that thread's
         * turns rather than the whole room.
         */
        const asked = withConversationContext(note, coachMessagesRef.current, {
          threadRootId: threadRootIdRef.current,
        });
        const result = await runCoachJob<{ reply: string }>(
          "ask",
          { task_id: problem.task_id, dataset: problem.dataset, question: asked },
          turnId,
          () => client.ask(problem.task_id, asked, problem.dataset),
        );
        finished = true;
        finishCoachTurn(turnId, [{ content: result.reply }]);
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        if (!finished) finishCoachTurn(turnId, null);
        setCoachPhase(null);
        setBusy(null);
      }
    },
    [client, problem, syncSolution, beginCoachTurn, finishCoachTurn, runCoachJob],
  );

  /** `runTests` fires this and is defined above it — see the auto-forward. */
  const askCoachRef = useRef<((question: string) => Promise<void>) | null>(null);
  askCoachRef.current = askCoach;

  const sendCoachChat = useCallback(
    (text: string, requestedFlags: CoachSendFlags) => {
      // Scratchpad has no solution.py, no review pipeline and no board regions
      // to draw into — Ask is the only flag that means anything there.
      const flags: CoachSendFlags = isScratchpad(problem)
        ? { ask: true, draw: false, reviewBoard: false, lazy: false, ...(requestedFlags.replyTo ? { replyTo: requestedFlags.replyTo } : {}) }
        : requestedFlags;
      const flagBits = [
        flags.ask ? "Ask" : null,
        flags.reviewBoard ? "Review" : null,
        flags.draw ? "Draw" : null,
        flags.lazy ? "Lazy" : null,
      ].filter((bit): bit is string => Boolean(bit));

      void (async () => {
        let attachments: CoachChatMessage["attachments"];

        /*
         * Marks on the code go as a picture; the code itself always goes as
         * text.
         *
         * Only when there is something drawn. With no annotation an image adds
         * nothing the source does not already say and costs a vision round-trip
         * to say it, so the plain-text path is not just the cheaper answer, it
         * is the better one. The picture is a re-render rather than a
         * screenshot because Monaco is HTML: a canvas export would come back as
         * marks floating over an empty rectangle, and a mark with nothing under
         * it tells a model nothing.
         */
        const codeShot = (() => {
          const board = boardRef.current;
          if (!board) return null;
          const blob = board.saveBoard();
          const ops = Array.isArray(blob.ink) ? blob.ink : [];
          if (ops.length === 0) return null;
          const frame = board
            .getElements()
            .find(
              (el) =>
                (el as { customData?: { lcRegion?: string; lcRegionFrame?: boolean } })
                  .customData?.lcRegion === "code" &&
                (el as { customData?: { lcRegionFrame?: boolean } }).customData
                  ?.lcRegionFrame,
            ) as { x?: number; y?: number; width?: number; height?: number } | undefined;
          if (!frame || typeof frame.x !== "number" || typeof frame.y !== "number") {
            return null;
          }
          const box = {
            minX: frame.x,
            minY: frame.y,
            maxX: frame.x + (frame.width ?? 0),
            maxY: frame.y + (frame.height ?? 0),
          };
          if (!hasCodeAnnotations(ops, box)) return null;
          const theme =
            BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];
          const png = renderAnnotatedCode({
            source: pseudocodeRef.current,
            ops,
            box,
            background: theme.background,
            textColor: isDarkTheme(themeId) ? "#e6edf3" : "#1b1f24",
            fontScene: statementLinePitch(readingSize) * 0.55,
          });
          return png ? { label: "Annotated code", png } : null;
        })();
        if ((flags.reviewBoard || flags.lazy) && boardRef.current) {
          try {
            const thumbs = await boardRef.current.exportRegionThumbs();
            if (thumbs.length > 0) {
              attachments = thumbs.map((thumb) => ({
                label: thumb.label,
                png: thumb.png,
              }));
            }
          } catch {
            /* thumbnails are best-effort */
          }
        }
        if (codeShot) {
          attachments = [...(attachments ?? []), codeShot];
        }

        pushCoachMessage("user", text || "Send", {
          ...(attachments ? { attachments } : {}),
          ...(flagBits.length > 0 ? { flags: flagBits } : {}),
          ...(flags.replyTo ? { replyTo: flags.replyTo } : {}),
        });

        /*
         * Say what is being replied to, for the model as well as the reader.
         *
         * The thread is a pointer, so without this the coach would get a bare
         * "why?" with no idea which of its own paragraphs the student meant.
         * Prefixed onto the prompt rather than stored in the message, so the
         * bubble stays clean and the quote is not duplicated on screen.
         */
        const prompt = flags.replyTo
          ? `Replying to your earlier message: “${flags.replyTo.excerpt}”\n\n${text}`
          : text;

        // Review runs the staged pipeline. Ask (or bare text without Review)
        // skips it and does a single-turn Q&A.
        if (flags.reviewBoard) {
          await submitForReview(prompt, true, attachments, flags.lazy);
        } else if (flags.ask || text) {
          await askCoach(prompt || "What should I focus on next?");
        }
        if (flags.draw) {
          await askForDiagram(text);
        }
        if (flags.lazy && problem) {
          setBusy("lazy fill…");
          try {
            await syncSolution();
            const board = boardRef.current;
            // Lazy assumes drawing: send the board (and ink) without relying on
            // the code dock as the source of truth.
            const snapshot = board
              ? await buildSnapshot(board, recognizerRef.current, {
                  pseudocode: undefined,
                  includePng: modeHasVision("review"),
                })
              : null;
            const lazyBoard = snapshot?.board ?? {
              recognized_text: text || "Lazy fill from board",
              pseudocode: pseudocodeRef.current.trim() || undefined,
            };
            const fill = await runCoachJob<LazyFillResponse>(
              "lazy",
              { task_id: problem.task_id, dataset: problem.dataset, board: lazyBoard },
              null,
              () => client.lazyFill(problem.task_id, lazyBoard, problem.dataset),
            );
            await applyFilledCode(fill.filled_code, fill.note);
          } catch (cause) {
            setError(messageOf(cause));
          } finally {
            setBusy(null);
          }
        }
      })();
    },
    [
      pushCoachMessage,
      submitForReview,
      askCoach,
      askForDiagram,
      problem,
      client,
      syncSolution,
      modeHasVision,
      applyFilledCode,
      runCoachJob,
    ],
  );

  /**
   * Run the workspace's tests and put the results everywhere they belong:
   * the modal over the board, the coach thread as an `app` turn, and the next
   * coach request as its own channel. One run, three destinations — closing
   * the modal therefore loses nothing.
   */
  const runTestsWith = useCallback(
    async (kind: "run" | "submit") => {
      if (!problem) return;
      setBusy(kind === "submit" ? "submitting…" : "running the tests…");
      setError(null);
      try {
        await syncSolution();
        const result = await client.runTests(problem.task_id, problem.dataset);
        setLastRunKind(kind);
        setTests(result);
        const report = formatTestReport(result, kind);
        lastTestReportRef.current = report;
        pushCoachMessage("app", report);
        dirtyRef.current = true;
        /*
         * Hand a red run straight to the coach, when asked to.
         *
         * The report is already in the thread, so the model would see it on the
         * next question anyway — what this buys is not having to ask. The code
         * rides along because a traceback without the source is a line number
         * with nothing at the end of it.
         */
        if (!result.all_passed && forwardFailuresRef.current) {
          void askCoachRef.current?.(describeRunFailure(report, pseudocodeRef.current));
        }
        if (result.all_passed) {
          setAttemptState((current) => ({
            solved: true,
            saved: current?.saved ?? false,
            archives: current?.archives ?? [],
            updated_at: Math.floor(Date.now() / 1000),
          }));
        }
        await refreshSession();
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusy(null);
      }
    },
    [client, problem, syncSolution, refreshSession, pushCoachMessage],
  );

  const runTests = useCallback(() => runTestsWith("run"), [runTestsWith]);
  const submitSolution = useCallback(() => runTestsWith("submit"), [runTestsWith]);

  const pickRandomProblem = useCallback(async () => {
    try {
      const next = await client.randomProblem(bankFilters);
      if (next) void pickProblem(next.task_id, { ...bankFilters, dataset: next.dataset });
      else setError("no problems match the current filters");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [client, bankFilters, pickProblem]);

  const startFreshSession = useCallback(
    async (taskIds: string[], bank: SearchOptions) => {
      try {
        setBankFilters(bank);
        let next = await client.resetSession();
        for (const id of taskIds) {
          next = await client.enqueueSession(id, bank.dataset);
        }
        setSession(next);
        setNavigateBySession(true);
        if (taskIds[0]) void pickProblem(taskIds[0], bank, { keepSessionNav: true });
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [client, pickProblem],
  );

  /** Confirmed by a short hold in `ConfirmDialog`, never by `window.confirm`. */
  const resetSession = useCallback(async () => {
    setResetPending(true);
    setResetError(null);
    try {
      setSession(await client.resetSession());
      setNavigateBySession(false);
      setResetOpen(false);
    } catch (cause) {
      setResetError(messageOf(cause));
    } finally {
      setResetPending(false);
    }
  }, [client]);

  const startRandomSession = useCallback(
    async (filters: SearchOptions = bankFilters) => {
      try {
        setBankFilters(filters);
        const next = await client.randomSession({
          dataset: filters.dataset,
          count: 5,
          difficulty: filters.difficulty,
          tag: filters.tag,
          q: filters.q,
        });
        setSession(next);
        setNavigateBySession(true);
        const first = next.queue[0];
        if (first) {
          const [firstDataset, firstTask] = splitProblemKey(first);
          void pickProblem(firstTask, { ...filters, dataset: firstDataset }, { keepSessionNav: true });
        }
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [client, bankFilters, pickProblem],
  );

  const openInIde = useCallback(async () => {
    if (!problem) return;
    try {
      await client.openWorkspace(problem.task_id, "ide", problem.dataset);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [client, problem]);

  // Deep link: ?task=<id>[&dataset=<slug>] loads that problem once. The TUI's
  // "Open in Canvas" builds this URL, and it names the dataset because the
  // same slug exists in several of them.
  useEffect(() => {
    if (deepLinkHandled.current || problem) return;
    const params = new URLSearchParams(window.location.search);
    const task = params.get("task");
    if (!task) return;
    deepLinkHandled.current = true;
    void pickProblem(task, { dataset: params.get("dataset") ?? DEFAULT_DATASET });
  }, [pickProblem, problem]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession, pairing]);

  /**
   * Persist the coach thread beside the workspace, debounced.
   *
   * Written on every change rather than only on leave: a crash or a closed lid
   * should not cost the conversation, and `attempt::finish` is what decides
   * whether the stored thread survives into the next attempt.
   */
  useEffect(() => {
    if (!problem || coachMessages.length === 0) return;
    const timer = window.setTimeout(() => {
      if (agentSaveSuspendedRef.current) return;
      const agent = persistableCoachMessages(coachMessages);
      if (isMdInk(problem)) return;
      if (isScratchpad(problem)) {
        // Board autosave only writes when the scene + ink fingerprint moves, so
        // a chat-only exchange would otherwise be lost. Write the notebook with
        // the current board so the thread survives a crash or a closed lid.
        const board = boardRef.current;
        const blob = board?.saveBoard();
        if (!blob) return;
        try {
          const saved = saveScratchNotebook({
            id: scratchNotebookId ?? undefined,
            board: blob,
            agent,
            pageCount: Math.max(scratchPageCount, countScratchPages(blob.elements)),
          });
          if (!scratchNotebookId) setScratchNotebookId(saved.id);
        } catch (cause) {
          if (cause instanceof ScratchpadLibraryFullError) {
            scratchLibResumeRef.current = null;
            setScratchLibOpen(true);
          }
        }
        return;
      }
      void client
        .putAgentSession(problem.task_id, agent, problem.dataset)
        .catch(() => {
          /* best-effort — the thread is still on screen */
        });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [client, problem, coachMessages, scratchNotebookId, scratchPageCount]);

  const confirmReveal = useCallback(async (mode: "bridge" | "lazy" = "bridge") => {
    const board = boardRef.current;
    if (!problem) return;
    const targetId = revealForMessageIdRef.current;
    setRevealOpen(false);
    setRevealPending(false);
    setRevealError(null);
    dirtyRef.current = true;
    setCoachMessages((current) => {
      const attachTo =
        (targetId && current.find((message) => message.id === targetId)) ||
        [...current].reverse().find((message) => message.role === "assistant" && message.review);
      if (!attachTo) return current;
      return current.map((message) =>
        message.id === attachTo.id
          ? { ...message, bridgePending: true, bridgeError: null }
          : message,
      );
    });
    try {
      const snapshot = board
        ? await buildSnapshot(board, recognizerRef.current, { pseudocode: pseudocodeRef.current })
        : null;
      const result = await client.reveal(
        problem.task_id,
        snapshot?.board ?? { recognized_text: "" },
        true,
        problem.dataset,
        mode,
      );
      if (mode === "lazy" && result.filled_code) {
        await applyFilledCode(
          result.filled_code,
          result.lazy_note ?? "Lazy fill applied from the hint.",
        );
      }
      setCoachMessages((current) => {
        const attachTo =
          (targetId && current.find((message) => message.id === targetId)) ||
          [...current].reverse().find(
            (message) => message.role === "assistant" && message.review && message.bridgePending,
          );
        if (!attachTo) return current;
        return current.map((message) =>
          message.id === attachTo.id
            ? { ...message, bridge: result, bridgePending: false, bridgeError: null }
            : message,
        );
      });
      revealForMessageIdRef.current = null;
    } catch (cause) {
      const message = messageOf(cause);
      setCoachMessages((current) => {
        const attachTo =
          (targetId && current.find((entry) => entry.id === targetId)) ||
          [...current].reverse().find(
            (entry) => entry.role === "assistant" && entry.review && entry.bridgePending,
          );
        if (!attachTo) return current;
        return current.map((entry) =>
          entry.id === attachTo.id
            ? { ...entry, bridgePending: false, bridgeError: message }
            : entry,
        );
      });
    }
  }, [client, problem, applyFilledCode]);

  const showDrawingFrame = useCallback(
    (programId: string, frameIndex: number) => {
      const board = boardRef.current;
      const api = sceneApi();
      if (!board || !api) return;
      dirtyRef.current = true;
      if (mobile) setActiveRegion("agent");
      setCoachMessages((current) => {
        const next = current.map((message) => {
          if (message.drawing?.program.id !== programId) return message;
          return {
            ...message,
            drawing: { ...message.drawing, frameIndex },
          };
        });
        const drawing = next.find((message) => message.drawing?.program.id === programId)?.drawing;
        if (drawing && drawing.expanded && !drawing.redacted) {
          applyViz(
            api,
            (skeletons) => board.convert(skeletons, { regenerateIds: false }),
            drawing.program,
            frameIndex,
          );
        }
        return next;
      });
    },
    [sceneApi, mobile],
  );

  const toggleDrawing = useCallback(
    (messageId: string, expanded: boolean) => {
      dirtyRef.current = true;
      if (expanded && mobile) setActiveRegion("agent");
      setCoachMessages((current) => {
        const next = setDrawingExpanded(current, messageId, expanded);
        queueMicrotask(() => syncDrawingsToBoard(next));
        return next;
      });
    },
    [syncDrawingsToBoard, mobile],
  );

  /** Reset every per-problem piece of state. Shared by leave and switch. */
  const clearProblemState = useCallback(() => {
    setTests(null);
    setNudges([]);
    setCoachMessages([]);
    setAttemptState(null);
    revealForMessageIdRef.current = null;
    lastReviewIdsRef.current = new Set();
    reviewTurnRef.current = 0;
    lastTestReportRef.current = null;
    dirtyRef.current = false;
  }, []);

  /**
   * Ask about saving before leaving, then do `next`.
   *
   * Only asked when there is something to keep: an untouched workspace has no
   * decision worth interrupting for. `AttemptDialog` explains which of the two
   * questions is being asked.
   */
  /**
   * Nothing has happened to this notebook since it opened.
   *
   * The fingerprint covers the scene and the ink op count together, so it
   * catches a stray stroke as readily as a page added and left blank. Without
   * a pristine hash — a notebook opened before this ran, say — the honest
   * answer is "assume they did something" and show the menu.
   */
  const scratchUntouched = useCallback(() => {
    const board = boardRef.current;
    const pristine = scratchPristineHashRef.current;
    if (!board || pristine === null) return false;
    return sceneFingerprint(board.getElements(), board.getInkOpCount()) === pristine;
  }, []);

  /**
   * Undo everything this session committed to the library.
   *
   * Restores the entry the session opened on, or deletes the notebook outright
   * when it opened blank — the autosave will have created one by now, and that
   * entry exists only because the writer was mid-session, not because they
   * asked for it.
   */
  /**
   * Treat what is in the library now as the thing to fall back to.
   *
   * Called after an explicit Save, so that a Discard later in the same session
   * rolls back to the save rather than past it. Without this, saving from the
   * scratchpad menu and then discarding on the way out would have thrown away
   * the save the writer had just asked for — the worst possible reading of a
   * button labelled Discard.
   */
  const rebaselineScratchSession = useCallback((id: string) => {
    scratchBaselineRef.current = { id, entry: getScratchNotebook(id) };
  }, []);

  const discardScratchSession = useCallback(() => {
    const baseline = scratchBaselineRef.current;
    if (baseline.entry && baseline.id) {
      restoreScratchNotebook(baseline.entry);
    } else if (scratchNotebookId) {
      deleteScratchNotebook(scratchNotebookId);
    }
    scratchBaselineRef.current = { id: null, entry: null };
    scratchPristineHashRef.current = null;
    setScratchNotebookId(null);
  }, [scratchNotebookId]);

  /** Nothing drawn on this document since it opened. */
  const mdInkUntouched = useCallback(() => {
    const board = boardRef.current;
    const pristine = mdInkPristineHashRef.current;
    if (!board || pristine === null) return false;
    return sceneFingerprint(board.getElements(), board.getInkOpCount()) === pristine;
  }, []);

  /**
   * Throw away this session's annotations — and only those.
   *
   * The markdown is never touched by any of this: the file on disk was only
   * ever read, and the library's copy of the text goes away with the entry it
   * belongs to. Discarding leaves the writer's document exactly as it was.
   */
  const discardMdInkSession = useCallback(() => {
    const baseline = mdInkBaselineRef.current;
    if (baseline.entry && baseline.id) {
      restoreMdInkDoc(baseline.entry);
    } else if (mdInkDocId) {
      deleteMdInkDoc(mdInkDocId);
    }
    mdInkBaselineRef.current = { id: null, entry: null };
    mdInkPristineHashRef.current = null;
    setMdInkDocId(null);
  }, [mdInkDocId]);

  /** Commit the annotations to the library. Returns the entry, or null on failure. */
  const saveMdInkSession = useCallback((): MdInkDoc | null => {
    const board = boardRef.current;
    const source = mdInkSource;
    if (!board || !source) return null;
    const blob = board.saveBoard();
    if (!blob) return null;
    try {
      const saved = saveMdInkDoc({
        id: mdInkDocId ?? undefined,
        name: source.name,
        hash: source.hash,
        source: source.text,
        board: blob,
      });
      setMdInkDocId(saved.id);
      // Discard now rolls back to this save, not past it.
      mdInkBaselineRef.current = { id: saved.id, entry: getMdInkDoc(saved.id) };
      return saved;
    } catch (cause) {
      if (cause instanceof MdInkLibraryFullError) {
        setError(cause.message);
        return null;
      }
      setError(messageOf(cause));
      return null;
    }
  }, [mdInkDocId, mdInkSource]);

  const leaveProblem = useCallback(
    (next: () => void) => {
      if (!problem) {
        next();
        return;
      }
      if (isScratchpad(problem)) {
        // A notebook nobody wrote in is not a decision worth interrupting for.
        // Leave straight away and take the autosave's placeholder with us.
        if (scratchUntouched()) {
          boardSaveSuspendedRef.current = true;
          discardScratchSession();
          next();
          return;
        }
        setLeavingError(null);
        setLeavingPhase("open");
        setLeaving({ run: next });
        return;
      }
      if (isMdInk(problem)) {
        // Same rule, same reason: an unannotated document is a document that
        // was only read, and reading it is not a decision.
        if (mdInkUntouched()) {
          boardSaveSuspendedRef.current = true;
          discardMdInkSession();
          next();
          return;
        }
        setLeavingError(null);
        setLeavingPhase("open");
        setLeaving({ run: next });
        return;
      }
      if (!dirtyRef.current) {
        next();
        return;
      }
      setLeavingError(null);
      setLeavingPhase("open");
      setLeaving({ run: next });
    },
    [discardMdInkSession, discardScratchSession, mdInkUntouched, problem, scratchUntouched],
  );

  const resolveLeave = useCallback(
    async (save: boolean) => {
      const pending = leaving;
      if (!problem || !pending || leavingPending) return;
      setLeavingPending(true);
      setLeavingError(null);
      boardSaveSuspendedRef.current = true;
      agentSaveSuspendedRef.current = true;

      // Fade the dialog out immediately and show the workspace loading spinner
      // underneath so save/API latency never leaves the modal stuck on screen.
      setLeavingPhase("exit");
      setSwitchMotion("busy");
      const fadeMs = prefersReducedMotion() ? 0 : LEAVE_DIALOG_FADE_MS;
      const fadeDone = waitMs(fadeMs);

      const dismissDialog = async () => {
        await fadeDone;
        setLeaving(null);
        setLeavingPhase("open");
      };

      try {
        if (isMdInk(problem)) {
          if (save) {
            const saved = saveMdInkSession();
            if (saved) setNotice(`Annotations saved for “${saved.name}”.`);
          } else {
            discardMdInkSession();
          }
          await dismissDialog();
          setLeavingPending(false);
          pending.run();
          return;
        }
        if (isScratchpad(problem)) {
          if (save) {
            const blob = boardRef.current?.saveBoard();
            if (blob) {
              try {
                const saved = saveScratchNotebook({
                  id: scratchNotebookId ?? undefined,
                  board: blob,
                  agent: persistableCoachMessages(coachMessages),
                  pageCount: Math.max(scratchPageCount, countScratchPages(blob.elements)),
                });
                setScratchNotebookId(saved.id);
                rebaselineScratchSession(saved.id);
              } catch (cause) {
                if (cause instanceof ScratchpadLibraryFullError) {
                  await dismissDialog();
                  setSwitchMotion("idle");
                  setLeavingPending(false);
                  // Re-open leave flow after the library dialog frees a slot.
                  setLeaving({ run: pending.run });
                  scratchLibResumeRef.current = () => {
                    void resolveLeave(true);
                  };
                  setScratchLibOpen(true);
                  return;
                }
                throw cause;
              }
            }
            setNotice("Notebook saved.");
          } else {
            // The autosave has been committing to the library all along, so
            // discarding is real work, not a skipped save.
            discardScratchSession();
          }
          await dismissDialog();
          setLeavingPending(false);
          pending.run();
          return;
        }
        // Flush the thread first, so a "save" keeps the last exchange and an
        // archive of a solved attempt is complete. Dialog is already fading —
        // don't wait on the network to start dismissing.
        const saveWork = (async () => {
          if (coachMessages.length > 0) {
            await client
              .putAgentSession(
                problem.task_id,
                persistableCoachMessages(coachMessages),
                problem.dataset,
              )
              .catch(() => {
                /* best-effort */
              });
          }
          await client.finishAttempt(
            problem.task_id,
            { solved: attemptState?.solved ?? tests?.all_passed ?? false, save },
            problem.dataset,
          );
        })();

        await dismissDialog();
        await saveWork;
        setLeavingPending(false);
        // Keep switchMotion busy — pending.run() (pickProblem / browse) takes over.
        pending.run();
      } catch (cause) {
        // The workspace is untouched on a failure — bring the dialog back.
        await fadeDone;
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setSwitchMotion("idle");
        setLeavingPhase("open");
        setLeavingPending(false);
        setLeavingError(messageOf(cause));
        // If we already unmounted during dismiss, remount with the error.
        setLeaving((current) => current ?? { run: pending.run });
      }
    },
    [
      client,
      discardMdInkSession,
      discardScratchSession,
      saveMdInkSession,
      rebaselineScratchSession,
      problem,
      leaving,
      leavingPending,
      coachMessages,
      attemptState,
      tests,
      scratchNotebookId,
      scratchPageCount,
    ],
  );

  const returnToBrowse = useCallback(() => {
    setSwitchMotion("idle");
    setBrowseMotion("enter");
    setActiveRegion("constraints");
    setProblem(null);
    setBoardPreparing(false);
    setHoldBrowseOverlay(false);
    setEntering(false);
    clearProblemState();
    setError(null);
    setCodeSlot(null);
    window.setTimeout(() => setBrowseMotion("idle"), slideDurationMs() || 1);
  }, [clearProblemState]);

  return (
    <div
      className={[
        "lc-app",
        mobile ? "lc-mobile" : "",
        problem ? "lc-app-problem" : "",
        coachOpen && problem ? "lc-app-coach-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="lc-header">
        <div className="lc-header-left">
          <Tip tip="lc whiteboard — your coding workspace">
            <strong className="lc-brand">lc whiteboard</strong>
          </Tip>
          {problem ? (
            <>
              <button
                type="button"
                className="lc-secondary lc-home lc-tip-target"
                data-tip="Return to the problem list"
                data-tip-placement="bottom"
                disabled={busy !== null}
                onClick={() => leaveProblem(returnToBrowse)}
              >
                <span className="lc-label-long">
                  {isLocalPad(problem) ? "← Home" : "← Problems"}
                </span>
                <span className="lc-label-short">←</span>
              </button>
              {!isLocalPad(problem) ? (
              <div className="lc-problem-nav" role="group" aria-label="Problem">
                <button
                  type="button"
                  className="lc-icon"
                  title={
                    navigateBySession && (session?.queue?.length ?? 0) > 0
                      ? "Previous in session queue"
                      : "Previous in problem bank"
                  }
                  aria-label="Previous problem"
                  disabled={!canStepPrev || busy !== null}
                  onClick={() => leaveProblem(() => void stepProblem(-1))}
                >
                  ‹
                </button>
                <span className="lc-current" title={problem.task_id}>
                  {titleFromSlug(problem.task_id, problem.question_id)}
                </span>
                <button
                  type="button"
                  className="lc-icon"
                  title={
                    navigateBySession && (session?.queue?.length ?? 0) > 0
                      ? "Next in session queue"
                      : "Next in problem bank"
                  }
                  aria-label="Next problem"
                  disabled={!canStepNext || busy !== null}
                  onClick={() => leaveProblem(() => void stepProblem(1))}
                >
                  ›
                </button>
              </div>
              ) : isMdInk(problem) ? (
                // The document is the thing being worked on, so it gets the
                // slot the problem's name would have had.
                <span className="lc-current" title={mdInkSource?.name ?? "Markdown"}>
                  {mdInkSource?.name ?? "Markdown"}
                </span>
              ) : (
                <span className="lc-current" title="Scratchpad">
                  Scratchpad
                </span>
              )}
            </>
          ) : (
            <span className="lc-muted lc-browse-hint">
              <span className="lc-label-long">pick a problem to start</span>
              <span className="lc-label-short">Problems</span>
            </span>
          )}
        </div>

        {/* Screen-centered — not balanced against left/right header chrome. */}
        <div className="lc-header-pairing-anchor">
          <div
            className={[
              "lc-header-pairing-slot",
              serverLink === "offline" && !pairingEditing && "lc-offline-chip-enter",
              pairingEditing && "lc-pairing-edit-enter",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {serverLink === "offline" && !pairingEditing ? (
              <HoldButton
                label="Offline"
                className="lc-offline-chip"
                ariaLabel="Offline: tap to edit host, hold to retry"
                holdMs={HOLD_SENSITIVE_MS}
                resetKey={gateOpen}
                onTap={() => setPairingEditing(true)}
                onConfirm={() => {
                  openGate("startup");
                  setGateWaiting(true);
                }}
              >
                Offline
              </HoldButton>
            ) : (
              <PairingBadge
                pairing={pairing}
                onPair={setPairing}
                editing={pairingEditing}
                onEditingChange={setPairingEditing}
              />
            )}
          </div>
        </div>

        <div className="lc-header-center">
          {problem && !isLocalPad(problem) && (
            <div className="lc-actions">
              <button
                type="button"
                className="lc-secondary"
                onClick={() => void runTests()}
                disabled={busy !== null}
                title="Run the sample tests"
                aria-label="Run tests"
              >
                <span className="lc-label-long">Run tests</span>
                <span className="lc-label-short" aria-hidden>
                  ▶
                </span>
              </button>
              <button
                type="button"
                className="lc-secondary"
                onClick={() => void submitSolution()}
                disabled={busy !== null}
                title="Sync solution, run all tests, and continue if they pass"
                aria-label="Submit"
              >
                <span className="lc-label-long">Submit</span>
                <span className="lc-label-short" aria-hidden>
                  ✓
                </span>
              </button>
              <button
                type="button"
                className="lc-secondary lc-desktop-only"
                disabled={busy !== null}
                onClick={() => void openInIde()}
                title="Open solution.py in Cursor / VS Code"
              >
                Open in IDE
              </button>
            </div>
          )}
        </div>

        <div className="lc-header-right">
          {/*
            Markdown icon, immediately left of the scratchpad's paper: tap picks
            a file to annotate, hold opens the library. Same split as its
            neighbour, since it is the same kind of thing.
          */}
          {!problem && (
            <HoldButton
              label="Markdown"
              ariaLabel="Markdown Ink: tap to open a file, hold for recent documents"
              className="lc-icon lc-tip-target lc-hold-icon"
              dataTip="Markdown — tap to open, hold for recent"
              dataTipPlacement="bottom"
              disabled={busy !== null}
              onTap={() => void pickAndOpenMdInk()}
              onConfirm={() => setMdInkEntryOpen(true)}
            >
              <svg
                className="lc-icon-svg"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
                {/* An "M" and a down-arrow — the markdown mark, at icon scale. */}
                <path d="M7 18v-5l2.2 2.6L11.4 13v5" />
                <path d="M14.6 13v5M12.9 16.4l1.7 1.6 1.7-1.6" />
              </svg>
            </HoldButton>
          )}
          {problem && isMdInk(problem) && (
            <button
              type="button"
              className="lc-icon lc-tip-target is-active"
              aria-label="Markdown documents"
              data-tip="Markdown — save / open"
              data-tip-placement="bottom"
              aria-pressed="true"
              disabled={busy !== null}
              onClick={() => setMdInkEntryOpen(true)}
            >
              <svg
                className="lc-icon-svg lc-icon-svg-filled"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" fill="none" />
              </svg>
            </button>
          )}
          {/*
            Paper icon: tap for a blank notebook, hold for the library.
            Starting to write is the common case by a wide margin, and it was
            behind a dialog whose other option nobody wanted most of the time.
          */}
          {!problem && (
            <HoldButton
              label="Scratchpad"
              ariaLabel="Scratchpad: tap for a new notebook, hold to open the library"
              className="lc-icon lc-tip-target lc-hold-icon"
              dataTip="Scratchpad — tap for new, hold to load"
              dataTipPlacement="bottom"
              disabled={busy !== null}
              onTap={() => void openScratchpad({ fresh: true })}
              onConfirm={() => setScratchEntryOpen(true)}
            >
              <svg
                className="lc-icon-svg"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
                <path d="M8 13h8" />
                <path d="M8 17h5" />
              </svg>
            </HoldButton>
          )}
          {problem && isScratchpad(problem) && (
            <button
              type="button"
              className="lc-icon lc-tip-target is-active"
              aria-label="Scratchpad notebooks"
              data-tip="Scratchpad — save / load"
              data-tip-placement="bottom"
              aria-pressed="true"
              disabled={busy !== null}
              onClick={() => setScratchEntryOpen(true)}
            >
              <svg
                className="lc-icon-svg lc-icon-svg-filled"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" fill="none" />
              </svg>
            </button>
          )}
          {/* On mobile the gear moves into the ⋯ menu — see HeaderOverflow. */}
          <button
            type="button"
            className="lc-icon lc-tip-target lc-desktop-only"
            aria-label="Settings"
            data-tip="Settings — paths, LLM, serve"
            data-tip-placement="bottom"
            onClick={() => setSettingsOpen(true)}
          >
            <svg
              className="lc-icon-svg"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
          {mobile && (
            <HeaderOverflow
              items={[
                { id: "settings", label: "Settings", disabled: false, run: () => setSettingsOpen(true) },
              ]}
            />
          )}
          {problem && (
            <button
              type="button"
              className={[
                coachOpen
                  ? "lc-secondary lc-coach-toggle lc-coach-toggle-open"
                  : "lc-secondary lc-coach-toggle",
                llmLink === "online" && "lc-coach-toggle-llm-on",
                llmLink === "offline" && "lc-coach-toggle-llm-off",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-expanded={coachOpen}
              aria-controls="lc-coach-panel"
              title={
                llmLink === "online"
                  ? "Coach — LLM online"
                  : llmLink === "offline"
                    ? "Coach — LLM offline"
                    : "Coach"
              }
              onClick={() => setCoachOpen((current) => !current)}
            >
              <span className="lc-coach-live-dot" aria-hidden />
              Coach
            </button>
          )}
        </div>
      </header>

      <main className="lc-main">
        <div className="lc-chrome-overlay-top" aria-live="polite">
          {busy && problem && switchMotion === "idle" && <div className="lc-busy">{busy}</div>}
          <StatusBanner text={error} variant="error" />
          <StatusBanner text={!error ? notice : null} variant="notice" />
        </div>
        <div
          className={[
            "lc-canvas-wrap",
            entering && "lc-entering",
            boardPreparing && "lc-canvas-preparing",
            !problem && "lc-canvas-idle",
            (switchMotion === "busy" || switchMotion === "done") && "lc-switching",
            // Lifts the ink layer over the dock — see the rule in styles.css.
            annotateCode && "lc-annotating-code",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <Board
            ref={boardRef}
            themeId={themeId}
            onThemePick={setThemeId}
            readingSize={readingSize}
            interactive={Boolean(problem) && switchMotion === "idle" && !boardPreparing}
            onCodeSlot={onCodeSlot}
            transparentCanvas={Boolean(problem && isMdInk(problem))}
            annotateToggle={Boolean(problem)}
            onAnnotateCodeChange={setAnnotateCode}
            // Ruled lines under somebody else's typography would be noise.
            linedPaperToggle={Boolean(problem) && !isMdInk(problem)}
            mobileRegion={
              problem
                ? isScratchpad(problem)
                  ? scratchPageId(scratchPageIndex)
                  : isMdInk(problem)
                    ? MD_INK_REGION
                    : mobile
                      ? activeRegion
                      : null
                : null
            }
            bottomCenter={
              problem && !isLocalPad(problem) && mobile ? (
                <RegionPager
                  active={activeRegion}
                  onPick={setActiveRegion}
                  disabled={busy !== null || boardPreparing}
                />
              ) : null
            }
            pageTitle={
              problem && isScratchpad(problem) ? (
                <ScratchPager
                  index={scratchPageIndex}
                  count={scratchPageCount}
                  onPick={setScratchPageIndex}
                  onAddPage={addScratchPage}
                  disabled={busy !== null || boardPreparing}
                />
              ) : null
            }
            pageContentHeight={
              problem && isMdInk(problem)
                ? mdInkPageHeight(mdInkHeight)
                : // The code page grows to the code for the same reason the
                  // document page grows to the document: so the thing being
                  // annotated and the ink on it move together.
                  problem && !isLocalPad(problem) && codeContentHeight
                  ? codeContentHeight + CODE_PAGE_TAIL
                  : null
            }
            pageContent={
              problem && isMdInk(problem) && mdInkSource ? (
                <MdInkDocument
                  source={mdInkSource.text}
                  onMeasure={onMdInkMeasure}
                />
              ) : null
            }
            coachFold={null}
          />
          {(!problem || holdBrowseOverlay) && (
            <div
              className={[
                "lc-overlay",
                browseMotion === "enter" && "lc-overlay-enter",
                (browseMotion === "busy" || (holdBrowseOverlay && boardPreparing)) &&
                  "lc-overlay-busy",
                browseMotion === "exit" && "lc-overlay-exit",
                (browseMotion === "done" ||
                  (holdBrowseOverlay && boardPreparing && browseMotion === "idle")) &&
                  "lc-overlay-done",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="lc-overlay-content">
                <ProblemBrowser
                  client={client}
                  onPick={pickProblem}
                  busy={busy !== null || boardPreparing}
                  themeId={themeId}
                  onThemePick={setThemeId}
                  session={session}
                  offline={serverLink !== "online"}
                  onStartSession={(ids, bank) => void startFreshSession(ids, bank)}
                  onResetSession={() => {
                    setResetError(null);
                    setResetOpen(true);
                  }}
                  onRandomSession={(filters) => void startRandomSession(filters)}
                />
              </div>
              {(browseMotion === "busy" ||
                browseMotion === "exit" ||
                browseMotion === "done" ||
                (holdBrowseOverlay && boardPreparing)) && (
                <WorkspaceLoadStatus
                  done={browseMotion === "done" || (holdBrowseOverlay && boardPreparing)}
                />
              )}
            </div>
          )}
          {problem && (switchMotion === "busy" || switchMotion === "done") && (
            <WorkspaceLoadStatus done={switchMotion === "done"} />
          )}
          {/* Monaco docks into the code frame — and on mobile that frame only
              exists on its own page, so the dock is mounted nowhere else. */}
          {problem && !isLocalPad(problem) && (!mobile || activeRegion === "code") && (() => {
            const slot = codeSlot ?? lastCodeSlotRef.current;
            if (!slot || slot.width <= 24 || slot.height <= 24) return null;
            const visible = Boolean(codeSlot);
            return (
              <div
                className={[
                  "lc-code-dock",
                  !visible && "lc-code-dock-offscreen",
                  // The pen cannot reach the ink layer through an editor that
                  // is still claiming every pointer that lands on it.
                  annotateCode && "lc-code-dock-annotating",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{
                  left: slot.left,
                  top: slot.top,
                  width: slot.width,
                  height: slot.height,
                  ["--lc-code-zoom" as string]: String(slot.zoom ?? 1),
                }}
                // Excalidraw listens for keys on document; keep them in the dock.
                onKeyDown={(event) => event.stopPropagation()}
                onKeyUp={(event) => event.stopPropagation()}
              >
                <PseudocodeEditor
                  key={problem.task_id}
                  value={pseudocode}
                  onChange={setPseudocode}
                  themeId={themeId}
                  zoom={slot.zoom ?? 1}
                  readingSize={readingSize}
                  defaultOpen
                  variant="dock"
                  onCodeHeight={setCodeContentHeight}
                />
              </div>
            );
          })()}
        </div>
      </main>

        {problem && (
          <AgentSidePanel
            open={coachOpen}
            mode={mode}
            onModeChange={setMode}
            onOpenChange={setCoachOpen}
            busy={busy !== null}
            thinking={busy !== null || thinking}
            thinkingPhase={coachPhase}
            messages={coachMessages}
            askOnly={isScratchpad(problem)}
            onThreadChange={(rootId) => {
              threadRootIdRef.current = rootId;
            }}
            forwardFailures={forwardFailures}
            onForwardFailuresChange={(on) => {
              setForwardFailures(on);
              saveForwardFailures(on);
            }}
            onSend={sendCoachChat}
            onRequestBridge={(messageId) => {
              revealForMessageIdRef.current = messageId;
              setRevealError(null);
              setRevealOpen(true);
            }}
            onToggleDrawing={toggleDrawing}
            onDrawingFrame={showDrawingFrame}
          >
            {AMBIENT_ENABLED && mode === "ambient" && (
              <AmbientPanel
                entries={nudges}
                connected={connected}
                thinking={thinking}
                provider={ambientProvider}
                lastSkip={lastSkip}
                onAnalyzeNow={() => {
                  if (!problem) return;
                  void coachRef.current?.analyzeNow(problem.task_id, capture, probe().sceneHash);
                }}
                onReset={() => {
                  coachRef.current?.reset();
                  setNudges([]);
                  lastIdsRef.current = new Set();
                }}
              />
            )}

          </AgentSidePanel>
        )}

      {resetOpen && (
        <ConfirmDialog
          title="Reset the practice session?"
          message="The session queue and its pass / fail progress are cleared. Your saved workspaces and solutions are not touched."
          detail={
            (session?.queue?.length ?? 0) > 0
              ? `${session?.queue.length} problem${session?.queue.length === 1 ? "" : "s"} queued · ${session?.stats?.passed ?? 0} passed · ${session?.stats?.failed ?? 0} failed`
              : undefined
          }
          confirmLabel="Reset"
          cancelLabel="Keep session"
          pending={resetPending}
          error={resetError}
          onConfirm={() => void resetSession()}
          onCancel={() => {
            if (resetPending) return;
            setResetOpen(false);
            setResetError(null);
          }}
        />
      )}

      {revealOpen && problem && (
        <RevealDialog
          taskId={problem.task_id}
          onConfirm={() => void confirmReveal("bridge")}
          onConfirmLazy={() => void confirmReveal("lazy")}
          onCancel={() => {
            if (revealPending) return;
            setRevealOpen(false);
            revealForMessageIdRef.current = null;
          }}
          pending={revealPending}
          error={revealError}
        />
      )}

      <TestResultsModal
        tests={tests}
        kind={lastRunKind}
        onClose={() => setTests(null)}
        onNext={() => {
          setTests(null);
          leaveProblem(() => void stepProblem(1));
        }}
        onRandom={() => {
          setTests(null);
          leaveProblem(() => void pickRandomProblem());
        }}
        onBrowse={() => {
          setTests(null);
          leaveProblem(returnToBrowse);
        }}
        canNext={canStepNext}
      />

      {leaving && problem && isScratchpad(problem) && (
        <ScratchpadDialog
          mode="leave"
          pending={leavingPending}
          exiting={leavingPhase === "exit"}
          error={leavingError}
          onChoose={(choice, notebookId) => {
            if (choice === "load" && notebookId) {
              setLeaving(null);
              setLeavingPhase("open");
              void openScratchpad({ notebookId });
              return;
            }
            void resolveLeave(choice === "save");
          }}
          onCancel={() => {
            if (leavingPending || leavingPhase === "exit") return;
            setLeaving(null);
            setLeavingError(null);
          }}
        />
      )}

      {leaving && problem && isMdInk(problem) && (
        <MdInkDialog
          mode="leave"
          docName={mdInkSource?.name ?? "this document"}
          pending={leavingPending}
          exiting={leavingPhase === "exit"}
          error={leavingError}
          onChoose={(choice) => void resolveLeave(choice === "save")}
          onCancel={() => {
            if (leavingPending || leavingPhase === "exit") return;
            setLeaving(null);
            setLeavingError(null);
          }}
        />
      )}

      {mdInkEntryOpen && (
        <MdInkDialog
          mode="entry"
          pending={busy !== null}
          allowSave={Boolean(problem && isMdInk(problem))}
          onChoose={(choice, docId) => {
            setMdInkEntryOpen(false);
            if (choice === "save") {
              const saved = saveMdInkSession();
              if (saved) setNotice(`Annotations saved for “${saved.name}”.`);
              return;
            }
            if (choice === "export") {
              exportMdInkAnnotations();
              return;
            }
            if (choice === "import") {
              void importMdInkAnnotations();
              return;
            }
            if (choice === "recent" && docId) {
              const entry = getMdInkDoc(docId);
              if (!entry) {
                setError("That document is no longer in the library.");
                return;
              }
              void openMdInk({ name: entry.name, text: entry.source, docId: entry.id });
              return;
            }
            void pickAndOpenMdInk();
          }}
          onCancel={() => setMdInkEntryOpen(false)}
        />
      )}

      {leaving && problem && !isLocalPad(problem) && (
        <AttemptDialog
          taskId={problem.task_id}
          solved={attemptState?.solved ?? tests?.all_passed ?? false}
          pending={leavingPending}
          exiting={leavingPhase === "exit"}
          error={leavingError}
          onChoose={(save) => void resolveLeave(save)}
          onCancel={() => {
            if (leavingPending || leavingPhase === "exit") return;
            setLeaving(null);
            setLeavingError(null);
          }}
        />
      )}

      {scratchEntryOpen && (
        <ScratchpadDialog
          mode="entry"
          pending={busy !== null}
          allowSave={Boolean(problem && isScratchpad(problem))}
          onChoose={(choice, notebookId) => {
            setScratchEntryOpen(false);
            if (choice === "save") {
              const board = boardRef.current;
              if (!board || !problem || !isScratchpad(problem)) return;
              try {
                const blob = board.saveBoard();
                const saved = saveScratchNotebook({
                  id: scratchNotebookId ?? undefined,
                  board: blob,
                  agent: persistableCoachMessages(coachMessages),
                  pageCount: Math.max(
                    scratchPageCount,
                    countScratchPages(blob.elements),
                  ),
                });
                setScratchNotebookId(saved.id);
                // Discard now rolls back to this save, not past it.
                rebaselineScratchSession(saved.id);
                setNotice(`Saved “${saved.title}”.`);
              } catch (cause) {
                if (cause instanceof ScratchpadLibraryFullError) {
                  scratchLibResumeRef.current = () => setScratchEntryOpen(true);
                  setScratchLibOpen(true);
                  return;
                }
                setError(messageOf(cause));
              }
              return;
            }
            if (choice === "load" && notebookId) {
              void openScratchpad({ notebookId });
              return;
            }
            void openScratchpad({ fresh: true });
          }}
          onCancel={() => setScratchEntryOpen(false)}
        />
      )}

      {scratchLibOpen && (
        <ScratchpadLibraryDialog
          onFreed={() => {
            setScratchLibOpen(false);
            const resume = scratchLibResumeRef.current;
            scratchLibResumeRef.current = null;
            resume?.();
          }}
          onCancel={() => {
            setScratchLibOpen(false);
            scratchLibResumeRef.current = null;
          }}
        />
      )}

      {bootPhase !== "gone" && (
        <div
          className={[
            "lc-server-gate-boot",
            bootPhase === "enter" || bootPhase === "show" ? "lc-server-gate-boot-enter" : "",
            bootPhase === "exit" ? "lc-server-gate-boot-exit" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="status"
          aria-live="polite"
          aria-label="Checking local server"
        >
          <LoadingDoodle />
          <div className="lc-spinner" aria-hidden="true" />
        </div>
      )}

      {gateOpen && (
        <ServerStatusDialog
          kind={gateKind}
          phase={gatePhase}
          waiting={gateWaiting}
          hostLabel={hostOf(pairing.baseUrl)}
          onWait={() => setGateWaiting(true)}
          onResumeChoice={() => setGateWaiting(false)}
          onOffline={() =>
            closeGate(
              "offline",
              gateKind === "dropped" ? "Continuing offline." : "Offline — scratchpad still works.",
            )
          }
        />
      )}

      {llmGateOpen && (
        <LlmStatusDialog
          phase={llmGatePhase}
          onOpenSettings={() => {
            closeLlmGate();
            setSettingsTab("server");
            setSettingsOpen(true);
          }}
          onContinueWithout={() => {
            closeLlmGate();
            setNotice("Coach off — Settings → Server when you want it back.");
          }}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        client={client}
        initialTab={settingsTab}
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
  );
}

interface OverflowItem {
  id: string;
  label: string;
  disabled: boolean;
  run: () => void;
}

/** The mobile "⋯": everything that doesn't earn a thumb-sized slot in the header. */
function HeaderOverflow({ items }: { items: OverflowItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="lc-overflow" ref={wrapRef}>
      <button
        type="button"
        className="lc-icon"
        aria-label="More actions"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        ⋯
      </button>
      {open && (
        <div className="lc-overflow-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="lc-overflow-item"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Scratchpad notebook pager — Next on the last page adds a blank page.
 *
 * It sits on the page's own title line rather than in the board's bottom row:
 * the notebook is what is being paged, so `‹ 1/3 ›` belongs above `Scratchpad`
 * the way a page number belongs on the paper. Board positions it through the
 * camera; the sizing here is in `em` so it scales with the slot's font size.
 */
function ScratchPager({
  index,
  count,
  onPick,
  onAddPage,
  disabled,
}: {
  index: number;
  count: number;
  onPick: (page: number) => void;
  onAddPage: () => void;
  disabled: boolean;
}) {
  const atEnd = index >= count - 1;
  return (
    <nav className="lc-page-pager" aria-label="Notebook pages">
      <button
        type="button"
        className="lc-page-pager-step"
        aria-label="Previous page"
        disabled={disabled || index <= 0}
        onClick={() => onPick(Math.max(0, index - 1))}
      >
        ‹
      </button>
      <span className="lc-page-pager-count">
        {index + 1}/{count}
      </span>
      <button
        type="button"
        className="lc-page-pager-step"
        aria-label={atEnd ? "Add page" : "Next page"}
        title={atEnd ? "Add page" : "Next page"}
        disabled={disabled || (atEnd && count >= SCRATCHPAD_PAGE_LIMIT)}
        onClick={() => {
          if (atEnd) onAddPage();
          else onPick(index + 1);
        }}
      >
        {atEnd && count < SCRATCHPAD_PAGE_LIMIT ? "+" : "›"}
      </button>
    </nav>
  );
}

/**
 * The mobile page turner: Prev / label / Next plus dots, over the canvas.
 *
 * It moves the *viewport*, not the scene — the board geography is identical to
 * desktop, so `board.json`, healing, and capture keep working unchanged.
 */
function RegionPager({
  active,
  onPick,
  disabled,
}: {
  active: RegionId;
  onPick: (region: RegionId) => void;
  disabled: boolean;
}) {
  const index = Math.max(0, MOBILE_REGION_ORDER.indexOf(active));
  const previous = MOBILE_REGION_ORDER[index - 1];
  const next = MOBILE_REGION_ORDER[index + 1];
  return (
    <nav className="lc-pager" aria-label="Board pages">
      <button
        type="button"
        className="lc-pager-step"
        aria-label={previous ? `Previous page: ${REGIONS[previous].label}` : "Previous page"}
        disabled={disabled || !previous}
        onClick={() => previous && onPick(previous)}
      >
        ‹
      </button>
      <div className="lc-pager-body">
        <span className="lc-pager-label">{REGIONS[active].label}</span>
        <div className="lc-pager-dots" role="tablist" aria-label="Board pages">
          {MOBILE_REGION_ORDER.map((region) => (
            <button
              key={region}
              type="button"
              role="tab"
              className={region === active ? "lc-pager-dot lc-pager-dot-active" : "lc-pager-dot"}
              aria-selected={region === active}
              aria-label={REGIONS[region].label}
              title={REGIONS[region].label}
              disabled={disabled}
              onClick={() => onPick(region)}
            />
          ))}
        </div>
      </div>
      <button
        type="button"
        className="lc-pager-step"
        aria-label={next ? `Next page: ${REGIONS[next].label}` : "Next page"}
        disabled={disabled || !next}
        onClick={() => next && onPick(next)}
      >
        ›
      </button>
    </nav>
  );
}

/**
 * Pairing, as three short fields: Host, Port, Code.
 *
 * The tablet has no rear camera worth pointing at a PC and nobody should retype
 * a 32-character token, so the six digits from the `lc serve --lan` banner are
 * the path — they buy one `POST /pair` and the app stores the real token that
 * comes back. Pasting the full `http://host:port?token=…` URL into Host still
 * works for anyone who has it on the clipboard.
 */
function PairingBadge({
  pairing,
  onPair,
  editing,
  onEditingChange,
}: {
  pairing: Pairing;
  onPair: (pairing: Pairing) => void;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const [host, setHost] = useState(() => hostnameOf(pairing.baseUrl));
  const [port, setPort] = useState(() => portOf(pairing.baseUrl));
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const fields = useRef({ host, port, code, pending });
  fields.current = { host, port, code, pending };

  const beginEdit = useCallback(() => {
    setHost(hostnameOf(pairing.baseUrl));
    setPort(portOf(pairing.baseUrl));
    setCode("");
    setProblem(null);
    onEditingChange(true);
  }, [onEditingChange, pairing.baseUrl]);

  const dismiss = useCallback(() => {
    onEditingChange(false);
    setHost(hostnameOf(pairing.baseUrl));
    setPort(portOf(pairing.baseUrl));
    setCode("");
    setProblem(null);
  }, [onEditingChange, pairing.baseUrl]);

  const commit = useCallback(async () => {
    const current = fields.current;
    if (current.pending) return;
    setProblem(null);

    // Power-user path: the whole URL from the banner, token and all.
    const pasted = parsePairingUrl(current.host.trim());
    if (pasted?.token) {
      savePairing(pasted);
      onPair(pasted);
      onEditingChange(false);
      return;
    }

    // No code typed: they are just moving the daemon's address, so keep the
    // token we already hold rather than forcing a re-pair.
    if (normalizePairCode(current.code).length === 0) {
      const baseUrl = pairingBaseUrl(current.host, current.port);
      if (!baseUrl) {
        setProblem("that host doesn't look right — try the Host line from the PC");
        return;
      }
      const next: Pairing = { baseUrl, token: pairing.token };
      savePairing(next);
      onPair(next);
      onEditingChange(false);
      return;
    }

    setPending(true);
    try {
      const paired = await pairWithCode(current.host, current.port, current.code);
      savePairing(paired);
      onPair(paired);
      setCode("");
      onEditingChange(false);
    } catch (cause) {
      setProblem(messageOf(cause));
    } finally {
      setPending(false);
    }
  }, [onEditingChange, onPair, pairing.token]);

  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (event: PointerEvent) => {
      if (formRef.current?.contains(event.target as Node)) return;
      // Tablet: tap away = Enter / pair.
      void commit();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [commit, dismiss, editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className="lc-link lc-pairing"
        title={pairing.token ? "paired — tap to change" : "loopback — tap to pair a daemon"}
        onClick={() => beginEdit()}
      >
        {hostOf(pairing.baseUrl)}
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      className="lc-pairing-form"
      onSubmit={(event) => {
        event.preventDefault();
        void commit();
      }}
    >
      <div className="lc-pairing-field">
        <input
          className="lc-pair-host"
          value={host}
          aria-label="Host"
          placeholder="192.168.1.20"
          autoFocus
          inputMode="decimal"
          disabled={pending}
          onChange={(event) => setHost(event.target.value)}
        />
        <input
          className="lc-pair-port"
          value={port}
          aria-label="Port"
          placeholder="7878"
          inputMode="numeric"
          disabled={pending}
          onChange={(event) => setPort(event.target.value)}
        />
        <input
          className="lc-pair-code-input"
          value={code}
          aria-label="Pairing code"
          placeholder="code"
          inputMode="numeric"
          maxLength={7}
          disabled={pending}
          onChange={(event) => setCode(event.target.value)}
        />
        <button
          type="submit"
          className="lc-pairing-return"
          aria-label="Pair"
          title="Pair"
          disabled={pending}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 7v6a4 4 0 0 1-4 4H6m0 0 3.5-3.5M6 17l3.5 3.5"
            />
          </svg>
        </button>
      </div>
      {problem ? (
        <span className="lc-warning">{problem}</span>
      ) : (
        <span className="lc-muted lc-pairing-hint">
          {pending ? "pairing…" : "Host, Port and the 6-digit Code from `lc serve --lan`"}
        </span>
      )}
    </form>
  );
}

/** `host:port`, for the badge — what you'd tell someone the app is talking to. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Just the host, for the Host field. */
function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

function portOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).port || String(DEFAULT_PORT);
  } catch {
    return String(DEFAULT_PORT);
  }
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

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Leave dialog fade duration (ms). Reduced-motion callers pass 0 at use sites. */
const LEAVE_DIALOG_FADE_MS = 180;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function slideDurationMs(): number {
  return prefersReducedMotion() ? 0 : 320;
}

function doneHoldMs(): number {
  return prefersReducedMotion() ? 0 : 560;
}

function boardFadeMs(): number {
  return prefersReducedMotion() ? 0 : 420;
}

function serverGateExitMs(): number {
  return prefersReducedMotion() ? 0 : 240;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Did the socket run fail for a reason HTTP would not share?
 *
 * A daemon older than run frames answers with a parse error; a dropped
 * connection reports itself. Both are worth retrying over HTTP. A model that
 * timed out, or a board the daemon refused, are not — those would fail the
 * same way twice and the second attempt only doubles the wait.
 */
function isSocketRunUnavailable(cause: unknown): boolean {
  const message = messageOf(cause).toLowerCase();
  return (
    message.includes("cannot parse frame") ||
    message.includes("unknown variant") ||
    message.includes("no run frames") ||
    message.includes("connection closed") ||
    message.includes("connection failed") ||
    message.includes("could not reach the coach")
  );
}

/**
 * Rebuild a stored coach thread.
 *
 * The daemon stores the transcript opaquely, so anything malformed is dropped
 * here rather than crashing the panel on a half-written file.
 */
function restoreCoachMessages(stored: unknown[]): CoachChatMessage[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const message = entry as Partial<CoachChatMessage> & { drawing?: unknown };
    if (typeof message.id !== "string" || typeof message.role !== "string") return [];
    // Older builds could persist an in-flight placeholder. Drop it — a turn
    // stuck on "Working…" would wait for a socket that will never answer.
    if (message.pending) return [];
    const drawing = restoreMessageDrawing(message.drawing);
    const content = typeof message.content === "string" ? message.content : "";
    const processEvents = Array.isArray(message.processEvents)
      ? message.processEvents
      : undefined;
    const flags = Array.isArray(message.flags)
      ? message.flags.filter((flag): flag is string => typeof flag === "string" && flag.length > 0)
      : undefined;
    // This function rebuilds a turn field by field, so anything not named here
    // is dropped on reload — a reply thread has to be carried explicitly or it
    // survives exactly until the page refreshes.
    const raw = message.replyTo;
    const replyTo =
      raw &&
      typeof raw.id === "string" &&
      typeof raw.role === "string" &&
      typeof raw.excerpt === "string"
        ? { id: raw.id, role: raw.role as CoachChatMessage["role"], excerpt: raw.excerpt }
        : undefined;
    // Empty assistant shells left after stripping `pending` are noise.
    if (
      message.role === "assistant" &&
      !content.trim() &&
      !message.review &&
      !message.bridge &&
      !message.attachments?.length &&
      !drawing &&
      !processEvents?.length
    ) {
      return [];
    }
    return [
      {
        id: message.id,
        role: message.role as CoachChatMessage["role"],
        content,
        at: typeof message.at === "number" ? message.at : Date.now(),
        review: message.review,
        bridge: message.bridge,
        attachments: message.attachments,
        ...(flags && flags.length > 0 ? { flags } : {}),
        ...(processEvents ? { processEvents } : {}),
        ...(drawing ? { drawing } : {}),
        ...(replyTo ? { replyTo } : {}),
      },
    ];
  });
}

/** Persist finished turns only — never an in-flight `pending` placeholder. */
function persistableCoachMessages(messages: CoachChatMessage[]): CoachChatMessage[] {
  return messages.filter((message) => !message.pending);
}

/**
 * Did the daemon refuse the request because the body was too big?
 *
 * Axum's own rejection is a plain-text 413 ("Failed to buffer the request body:
 * length limit exceeded"), and a reverse proxy in front of it may phrase it
 * differently, so match the status first and the wording second.
 */
function isBodyLimitError(cause: unknown): boolean {
  if (cause instanceof LcApiError && cause.status === 413) return true;
  const message = messageOf(cause).toLowerCase();
  return (
    message.includes("length limit") ||
    message.includes("payload too large") ||
    message.includes("body too large") ||
    message.includes("request entity too large")
  );
}

/** Local VLMs often hang on a board PNG until the 180s client timeout fires. */
function isLlmTimeoutError(cause: unknown): boolean {
  const message = messageOf(cause).toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("operation timed out")
  );
}

/** Shared spinner → checkmark used by browse pick and ‹ › problem switch. */
function WorkspaceLoadStatus({ done }: { done: boolean }) {
  return (
    <div
      className="lc-overlay-spinner"
      role="status"
      aria-live="polite"
      aria-label={done ? "Workspace ready" : "Loading workspace"}
    >
      {!done && <LoadingDoodle />}
      {done ? (
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
  );
}
