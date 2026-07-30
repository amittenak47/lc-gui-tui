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
  ProblemDetail,
  ReviewResponse,
  ServerFrame,
  SessionSnapshot,
  TestResponse,
} from "./api/types";
import { DEFAULT_DATASET } from "./api/types";
import { Tip } from "./components/Tip";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { SettingsModal } from "./components/SettingsModal";
import { Board } from "./canvas/Board";
import { loadBoardReadingSize, saveBoardReadingSize, type BoardReadingSize } from "./modes/codeFontSize";
import type { BoardHandle, ScreenRect } from "./canvas/BoardHandle";
import { sceneHash, studentAuthoredElements, studentElements } from "./canvas/capture";
import type { StructureBaseline } from "./canvas/boardDelta";
import { MlKitRecognizer, NoopRecognizer, pickRecognizer, type InkRecognizer } from "./canvas/ink";
import { buildSnapshot, sceneFingerprint, structureBaselineFromBoard } from "./canvas/snapshot";
import { sha256Hex } from "./util/codeHash";
import { skeletonOf } from "./util/solutionSplit";
import {
  AgentSidePanel,
  AMBIENT_ENABLED,
  type CoachChatMessage,
  type CoachSendFlags,
} from "./modes/AgentSidePanel";
import { AttemptDialog } from "./modes/AttemptDialog";
import { formatTestReport, TestResultsModal } from "./modes/TestResultsModal";
import { AmbientPanel, type AmbientEntry } from "./modes/AmbientPanel";
import { ProblemBrowser } from "./modes/ProblemBrowser";
import { PseudocodeEditor } from "./modes/PseudocodeEditor";
import { RevealDialog } from "./modes/RevealDialog";
import { buildProblemTemplate } from "./templates/problemBoard";
import { REGIONS, STUDENT_REGION_ORDER, type RegionId } from "./templates/regions";
import { splitProblemKey } from "./util/datasetKey";
import { isMobileViewport, useIsMobile } from "./util/mobile";
import { installSafeAreaInsets } from "./util/safeArea";
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
  const [pairing, setPairing] = useState<Pairing>(() => loadPairing());
  const client = useMemo(() => new LcClient(pairing), [pairing]);

  const boardRef = useRef<BoardHandle | null>(null);
  const [recognizer, setRecognizer] = useState<InkRecognizer>(() => new NoopRecognizer());

  const [problem, setProblem] = useState<ProblemDetail | null>(null);
  const [mode, setMode] = useState<Mode>("review");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Something the student should know, but which did not stop the request. */
  const [notice, setNotice] = useState<string | null>(null);
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
  const [readingSize, setReadingSize] = useState<BoardReadingSize>(() =>
    // Desktop zooms with the wheel — S/M/L only fights statement vs Monaco scale.
    isMobileViewport() ? loadBoardReadingSize() : "M",
  );
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
    // Desktop stays flat at Medium; only persist S/M/L on mobile.
    if (!mobile) {
      if (readingSize !== "M") setReadingSize("M");
      return;
    }
    saveBoardReadingSize(readingSize);
  }, [mobile, readingSize]);

  const [tests, setTests] = useState<TestResponse | null>(null);
  const [capabilities, setCapabilities] = useState<CoachCapabilities | null>(null);

  /** Attempt state for the open problem, so the leave dialog asks the right question. */
  const [attemptState, setAttemptState] = useState<AttemptState | null>(null);
  /** Pending "you're leaving — save or discard?" choice, with what to do after. */
  const [leaving, setLeaving] = useState<{ run: () => void } | null>(null);
  const [leavingPending, setLeavingPending] = useState(false);
  const [leavingError, setLeavingError] = useState<string | null>(null);

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
   * The mobile coach is a bottom sheet, so opening it takes ~46vh away from the
   * canvas. Excalidraw resizes itself, but the fit is ours — without this the
   * page you were reading stays scrolled where it was and half of it is behind
   * the sheet.
   */
  useEffect(() => {
    if (!mobile || !problem) return;
    void boardRef.current?.settleFitView();
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
          (skeletons) => board.convert(skeletons),
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

  // Debounced board persistence — skip when sceneHash is unchanged.
  const lastSavedHashRef = useRef<number | null>(null);
  useEffect(() => {
    if (!problem) return;
    const timer = window.setInterval(() => {
      const board = boardRef.current;
      if (!board || boardSaveSuspendedRef.current) return;
      const elements = board.getElements();
      const hash = sceneHash(elements);
      if (lastSavedHashRef.current === hash) return;
      const blob = board.saveBoard();
      dirtyRef.current = true;
      void client.putBoard(problem.task_id, blob, problem.dataset).then(() => {
        lastSavedHashRef.current = hash;
      }).catch(() => {
        /* best-effort */
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [client, problem]);

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

  const modeHasVision = useCallback(
    (modeName: string) =>
      capabilities?.modes.find((entry) => entry.mode === modeName)?.vision === true,
    [capabilities],
  );

  const syncSolution = useCallback(async () => {
    if (!problem) return;
    await client.putSolution(problem.task_id, pseudocodeRef.current, problem.dataset);
  }, [client, problem]);

  /** App-side channel on every coach request: the last test run, as fact. */
  const appMessages = useCallback(
    () => (lastTestReportRef.current ? [lastTestReportRef.current] : undefined),
    [],
  );

  const pickProblem = useCallback(
    async (taskId: string, bank?: SearchOptions, opts?: { keepSessionNav?: boolean }) => {
      const datasetId = bank?.dataset ?? DEFAULT_DATASET;
      const fromBrowse = !problem;
      const switching = Boolean(problem);
      setActiveRegion("constraints");
      setBusy("loading the workspace…");
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
      // A plain table click is a cursor, not a session — only Start / Random
      // keep queue-based ‹ › navigation.
      if (!opts?.keepSessionNav) setNavigateBySession(false);
      if (fromBrowse) {
        setHoldBrowseOverlay(true);
        setBrowseMotion("busy");
      }
      if (switching) setSwitchMotion("busy");
      try {
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

        const skeletons = buildProblemTemplate({
          taskId: detail.task_id,
          title: titleFromSlug(detail.task_id, detail.question_id),
          difficulty: detail.difficulty,
          tags: detail.tags,
          description: detail.problem_description,
          caseCount: detail.cases.length,
          dark: isDarkTheme(themeId),
        });

        // A saved layout is restored over the fresh template; otherwise seed
        // the template alone. Persisted boards can carry old region geometry,
        // so `restoreBoard` heals them against the current skeletons.
        lastSavedHashRef.current = null;
        const saved = loaded.resume.board as
          | { v?: number; elements?: unknown[]; appState?: unknown }
          | null;
        if (saved && saved.v === 1 && Array.isArray(saved.elements) && saved.elements.length > 0) {
          boardRef.current?.restoreBoard(saved.elements, saved.appState, { skeletons });
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

  // Ambient mode's lifecycle. Never entered while `AMBIENT_ENABLED` is false —
  // the socket is not opened and no polling timer is created.
  useEffect(() => {
    if (!AMBIENT_ENABLED || mode !== "ambient" || !problem) return;

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
    coach.start(problem.task_id, probe, capture);

    return () => {
      coach.stop();
      coachRef.current = null;
      setConnected(false);
      setThinking(false);
    };
  }, [mode, problem, pairing, probe, capture]);

  const pushCoachMessage = useCallback(
    (
      role: CoachChatMessage["role"],
      content: string,
      extra?: Pick<
        CoachChatMessage,
        "review" | "attachments" | "drawing" | "bridge" | "bridgePending" | "bridgeError"
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

    const phaseTimers: number[] = [];
    const note = studentNote?.trim() ?? "";
    const topic =
      note.length > 0
        ? note.length > 48
          ? `${note.slice(0, 48)}…`
          : note
        : includeBoard
          ? "your board"
          : "your question";
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
          setError("type a question, or turn on Review board");
          return;
        }
        payload = {
          recognized_text: `Student asks:\n${note}`,
          pseudocode: pseudocodeRef.current.trim() || undefined,
          turn_index: reviewTurnRef.current,
        };
      }
      let result: ReviewResponse;
      try {
        result = await client.review(
          problem.task_id,
          { ...payload, app_messages: appMessages() },
          problem.dataset,
          { layoutOnly },
        );
      } catch (cause) {
        // The picture is the first thing to give up: a board too big to buffer,
        // or a local VLM that hangs on the PNG, must not cost the whole review.
        const hasPng = "png" in payload && Boolean(payload.png);
        if (!hasPng || (!isBodyLimitError(cause) && !isLlmTimeoutError(cause))) throw cause;
        const { png: _png, ...withoutPng } = payload;
        result = await client.review(
          problem.task_id,
          { ...withoutPng, app_messages: appMessages() },
          problem.dataset,
          { layoutOnly },
        );
        setNotice(
          isLlmTimeoutError(cause)
            ? "the board image timed out at the model — the coach reviewed your text and layout without it"
            : "the board image was too large to send — the coach reviewed your text and layout without it",
        );
      }
      // One structured card in the thread — do not also push a prose duplicate.
      // Attachments show what the coach saw (same layouts as the user turn).
      pushCoachMessage("assistant", "", {
        review: result,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
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
      for (const id of phaseTimers) window.clearTimeout(id);
      setCoachPhase(null);
      setBusy(null);
    }
  }, [client, problem, syncSolution, pushCoachMessage, modeHasVision, appMessages]);

  const askForDiagram = useCallback(async (ask = "") => {
    const board = boardRef.current;
    if (!board || !problem) return;
    setBusy("drawing…");
    setError(null);
    setCoachOpen(true);
    try {
      await syncSolution();
      const snapshot = await buildSnapshot(board, recognizerRef.current, {
        pseudocode: pseudocodeRef.current,
        includePng: modeHasVision("viz"),
      });
      const envelope = await client.viz(
        problem.task_id,
        { ...snapshot.board, app_messages: appMessages() },
        ask,
        problem.dataset,
      );
      const drawables = envelope.programs
        .map(parseVizProgram)
        .filter((candidate): candidate is VizProgram => candidate !== null)
        .slice(0, MAX_VISIBLE_DRAWINGS);

      if (drawables.length > 0) {
        dirtyRef.current = true;
        setCoachMessages((current) => {
          const stamp = Date.now();
          let next: CoachChatMessage[] = [
            ...current,
            ...drawables.map((drawable, index) => ({
              id: `assistant-${stamp}-${index}-${Math.random().toString(36).slice(2, 7)}`,
              role: "assistant" as const,
              content:
                drawables.length === 1
                  ? "Drew a diagram on the board."
                  : `Drew diagram ${index + 1} of ${drawables.length} on the board.`,
              at: stamp,
              drawing: withNewDrawing(drawable),
            })),
          ];
          next = enforceVisibleDrawingCap(next, MAX_VISIBLE_DRAWINGS);
          queueMicrotask(() => syncDrawingsToBoard(next));
          return next;
        });
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
          pushCoachMessage("assistant", envelope.message.trim());
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
      setBusy(null);
    }
  }, [client, problem, syncSolution, modeHasVision, sceneApi, appMessages, syncDrawingsToBoard]);

  const applyFilledCode = useCallback(
    async (filled: string, note: string) => {
      if (!problem) return;
      const next = filled.trim();
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

  const sendCoachChat = useCallback(
    (text: string, flags: CoachSendFlags) => {
      const flagBits = [
        flags.reviewBoard ? "Review board" : null,
        flags.draw ? "Draw" : null,
        flags.lazy ? "Lazy" : null,
      ].filter(Boolean);
      const shown = [text, flagBits.length > 0 ? flagBits.join(" · ") : null]
        .filter(Boolean)
        .join("\n");

      void (async () => {
        let attachments: CoachChatMessage["attachments"];
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
        pushCoachMessage("user", shown || "Send", attachments ? { attachments } : undefined);

        if (flags.reviewBoard || text) {
          await submitForReview(text, flags.reviewBoard, attachments, flags.lazy);
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
            const fill = await client.lazyFill(
              problem.task_id,
              snapshot?.board ?? {
                recognized_text: text || "Lazy fill from board",
                pseudocode: pseudocodeRef.current.trim() || undefined,
              },
              problem.dataset,
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
      askForDiagram,
      problem,
      client,
      syncSolution,
      modeHasVision,
      applyFilledCode,
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
      void client
        .putAgentSession(problem.task_id, coachMessages, problem.dataset)
        .catch(() => {
          /* best-effort — the thread is still on screen */
        });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [client, problem, coachMessages]);

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
          applyViz(api, (skeletons) => board.convert(skeletons), drawing.program, frameIndex);
        }
        return next;
      });
    },
    [sceneApi],
  );

  const toggleDrawing = useCallback(
    (messageId: string, expanded: boolean) => {
      dirtyRef.current = true;
      setCoachMessages((current) => {
        const next = setDrawingExpanded(current, messageId, expanded);
        queueMicrotask(() => syncDrawingsToBoard(next));
        return next;
      });
    },
    [syncDrawingsToBoard],
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
  const leaveProblem = useCallback(
    (next: () => void) => {
      if (!problem || !dirtyRef.current) {
        next();
        return;
      }
      setLeavingError(null);
      setLeaving({ run: next });
    },
    [problem],
  );

  const resolveLeave = useCallback(
    async (save: boolean) => {
      const pending = leaving;
      if (!problem || !pending) return;
      setLeavingPending(true);
      setLeavingError(null);
      boardSaveSuspendedRef.current = true;
      agentSaveSuspendedRef.current = true;
      try {
        // Flush the thread first, so a "save" keeps the last exchange and an
        // archive of a solved attempt is complete.
        if (coachMessages.length > 0) {
          await client
            .putAgentSession(problem.task_id, coachMessages, problem.dataset)
            .catch(() => {
              /* best-effort */
            });
        }
        await client.finishAttempt(
          problem.task_id,
          { solved: attemptState?.solved ?? tests?.all_passed ?? false, save },
          problem.dataset,
        );
        setLeaving(null);
        pending.run();
      } catch (cause) {
        // The workspace is untouched on a failure, so let autosave resume.
        boardSaveSuspendedRef.current = false;
        agentSaveSuspendedRef.current = false;
        setLeavingError(messageOf(cause));
      } finally {
        setLeavingPending(false);
      }
    },
    [client, problem, leaving, coachMessages, attemptState, tests],
  );

  const returnToBrowse = useCallback(() => {
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
                <span className="lc-label-long">← Problems</span>
                <span className="lc-label-short">←</span>
              </button>
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
            </>
          ) : (
            <span className="lc-muted lc-browse-hint">
              <span className="lc-label-long">pick a problem to start</span>
              <span className="lc-label-short">Problems</span>
            </span>
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
        </div>

        <div className="lc-header-center">
          <PairingBadge pairing={pairing} onPair={setPairing} />
          {problem && (
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
              className={
                coachOpen
                  ? "lc-secondary lc-coach-toggle lc-coach-toggle-open"
                  : "lc-secondary lc-coach-toggle"
              }
              aria-expanded={coachOpen}
              aria-controls="lc-coach-panel"
              onClick={() => setCoachOpen((current) => !current)}
            >
              Coach
            </button>
          )}
        </div>
      </header>

      {busy && problem && switchMotion === "idle" && <div className="lc-busy">{busy}</div>}
      {error && (
        <div className="lc-warning lc-banner">
          <span>{error}</span>
          <button type="button" className="lc-link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}
      {notice && !error && (
        <div className="lc-banner lc-notice">
          <span>{notice}</span>
          <button type="button" className="lc-link" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      )}

      <main className="lc-main">
        <div
          className={[
            "lc-canvas-wrap",
            entering && "lc-entering",
            boardPreparing && "lc-canvas-preparing",
            !problem && "lc-canvas-idle",
            (switchMotion === "busy" || switchMotion === "done") && "lc-switching",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <Board
            ref={boardRef}
            themeId={themeId}
            onThemePick={setThemeId}
            readingSize={readingSize}
            onReadingSizeChange={setReadingSize}
            interactive={Boolean(problem) && switchMotion === "idle" && !boardPreparing}
            onCodeSlot={onCodeSlot}
            mobileRegion={mobile && problem ? activeRegion : null}
            bottomCenter={
              problem && mobile ? (
                <RegionPager
                  active={activeRegion}
                  onPick={setActiveRegion}
                  disabled={busy !== null || boardPreparing}
                />
              ) : null
            }
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
          {problem && (!mobile || activeRegion === "code") && (() => {
            const slot = codeSlot ?? lastCodeSlotRef.current;
            if (!slot || slot.width <= 24 || slot.height <= 24) return null;
            const visible = Boolean(codeSlot);
            return (
              <div
                className={visible ? "lc-code-dock" : "lc-code-dock lc-code-dock-offscreen"}
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
            busy={busy !== null}
            thinking={busy !== null || thinking}
            thinkingPhase={coachPhase}
            messages={coachMessages}
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

      {leaving && problem && (
        <AttemptDialog
          taskId={problem.task_id}
          solved={attemptState?.solved ?? tests?.all_passed ?? false}
          pending={leavingPending}
          error={leavingError}
          onChoose={(save) => void resolveLeave(save)}
          onCancel={() => {
            if (leavingPending) return;
            setLeaving(null);
            setLeavingError(null);
          }}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        client={client}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          void client.capabilities().then(setCapabilities).catch(() => setCapabilities(null));
        }}
      />
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
  const index = Math.max(0, STUDENT_REGION_ORDER.indexOf(active));
  const previous = STUDENT_REGION_ORDER[index - 1];
  const next = STUDENT_REGION_ORDER[index + 1];
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
          {STUDENT_REGION_ORDER.map((region) => (
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
}: {
  pairing: Pairing;
  onPair: (pairing: Pairing) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [host, setHost] = useState(() => hostnameOf(pairing.baseUrl));
  const [port, setPort] = useState(() => portOf(pairing.baseUrl));
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const fields = useRef({ host, port, code, pending });
  fields.current = { host, port, code, pending };

  const dismiss = useCallback(() => {
    setEditing(false);
    setHost(hostnameOf(pairing.baseUrl));
    setPort(portOf(pairing.baseUrl));
    setCode("");
    setProblem(null);
  }, [pairing.baseUrl]);

  const commit = useCallback(async () => {
    const current = fields.current;
    if (current.pending) return;
    setProblem(null);

    // Power-user path: the whole URL from the banner, token and all.
    const pasted = parsePairingUrl(current.host.trim());
    if (pasted?.token) {
      savePairing(pasted);
      onPair(pasted);
      setEditing(false);
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
      setEditing(false);
      return;
    }

    setPending(true);
    try {
      const paired = await pairWithCode(current.host, current.port, current.code);
      savePairing(paired);
      onPair(paired);
      setCode("");
      setEditing(false);
    } catch (cause) {
      setProblem(messageOf(cause));
    } finally {
      setPending(false);
    }
  }, [onPair, pairing.token]);

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
        onClick={() => {
          setHost(hostnameOf(pairing.baseUrl));
          setPort(portOf(pairing.baseUrl));
          setCode("");
          setProblem(null);
          setEditing(true);
        }}
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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
    const drawing = restoreMessageDrawing(message.drawing);
    return [
      {
        id: message.id,
        role: message.role as CoachChatMessage["role"],
        content: typeof message.content === "string" ? message.content : "",
        at: typeof message.at === "number" ? message.at : Date.now(),
        review: message.review,
        bridge: message.bridge,
        attachments: message.attachments,
        ...(drawing ? { drawing } : {}),
      },
    ];
  });
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
