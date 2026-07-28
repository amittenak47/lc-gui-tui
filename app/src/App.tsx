/**
 * The whole loop, wired together.
 *
 * Two modes, per the plan:
 *
 * - **Review** — draw, tap Submit, get a verdict and a counterexample.
 * - **Ambient** — the coach glances at the board every 60 seconds and nudges,
 *   in the side panel only, never on the canvas.
 *
 * Both talk to `lc serve`. Nothing about the corpus, the workspaces, or the
 * Python runner lives on this device.
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
  BridgeResponse,
  ProblemDetail,
  ReviewResponse,
  ServerFrame,
  SessionSnapshot,
  TestResponse,
} from "./api/types";
import { Tip } from "./components/Tip";
import { SettingsModal } from "./components/SettingsModal";
import { Board } from "./canvas/Board";
import { loadBoardReadingSize, saveBoardReadingSize, type BoardReadingSize } from "./modes/codeFontSize";
import type { BoardHandle, ScreenRect } from "./canvas/BoardHandle";
import { sceneHash, studentAuthoredElements, studentElements } from "./canvas/capture";
import type { StructureBaseline } from "./canvas/boardDelta";
import { MlKitRecognizer, NoopRecognizer, pickRecognizer, type InkRecognizer } from "./canvas/ink";
import { buildSnapshot, sceneFingerprint, structureBaselineFromBoard } from "./canvas/snapshot";
import { sha256Hex } from "./util/codeHash";
import { AgentSidePanel, type CoachChatMessage, type CoachSendFlags } from "./modes/AgentSidePanel";
import { AmbientPanel, type AmbientEntry } from "./modes/AmbientPanel";
import { ProblemBrowser } from "./modes/ProblemBrowser";
import { PseudocodeEditor } from "./modes/PseudocodeEditor";
import { BridgePanel, RevealDialog } from "./modes/RevealDialog";
import { ReviewPanel } from "./modes/ReviewPanel";
import { buildProblemTemplate } from "./templates/problemBoard";
import { REGIONS, STUDENT_REGION_ORDER, type RegionId } from "./templates/regions";
import { useIsMobile } from "./util/mobile";
import { titleFromSlug } from "./util/text";
import { ensureCodingRoom } from "./util/solutionPad";
import { applyAppTheme, isDarkTheme, loadThemeId, saveThemeId } from "./theme/appThemes";
import { Timeline } from "./viz/Timeline";
import {
  applyAnnotation,
  applyHighlight,
  applyViz,
  clearAllViz,
  removeViz,
  type SceneApi,
} from "./viz/apply";
import { renderAnnotation } from "./viz/render/annotation";
import { renderHighlight } from "./viz/render/highlight";
import { parseVizProgram, type VizProgram } from "./viz/schema";
import type { CoachCapabilities } from "./api/types";

const MAX_CONCURRENT_PROGRAMS = 4;

type Mode = "review" | "ambient";

export function App() {
  const mobile = useIsMobile();
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
  const [canStepPrev, setCanStepPrev] = useState(false);
  const [canStepNext, setCanStepNext] = useState(false);
  /** Distinguishes header Run tests vs Submit for the results panel. */
  const [lastRunKind, setLastRunKind] = useState<"run" | "submit">("run");
  const [themeId, setThemeId] = useState(loadThemeId);
  const [readingSize, setReadingSize] = useState<BoardReadingSize>(() => loadBoardReadingSize());
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
    saveBoardReadingSize(readingSize);
  }, [readingSize]);

  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [tests, setTests] = useState<TestResponse | null>(null);
  const [programs, setPrograms] = useState<VizProgram[]>([]);
  const [, setFrameByProgram] = useState<Record<string, number>>({});
  const [capabilities, setCapabilities] = useState<CoachCapabilities | null>(null);

  const [revealOpen, setRevealOpen] = useState(false);
  const [revealPending, setRevealPending] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [bridge, setBridge] = useState<BridgeResponse | null>(null);

  const [nudges, setNudges] = useState<AmbientEntry[]>([]);
  const [coachMessages, setCoachMessages] = useState<CoachChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [thinking, setThinking] = useState(false);
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
  const skeletonHashRef = useRef<string | undefined>(undefined);
  const coachRef = useRef<AmbientCoach | null>(null);
  // The recognizer can be swapped after mount; read it through a ref so the
  // ambient loop doesn't need to restart when it lands.
  const recognizerRef = useRef(recognizer);
  recognizerRef.current = recognizer;
  // Read through a ref for the same reason: otherwise every keystroke in the
  // pseudocode editor would tear down and restart the ambient loop.
  const pseudocodeRef = useRef(pseudocode);
  pseudocodeRef.current = pseudocode;

  // Keep the dashed code frame tall enough for the Monaco solution.
  useEffect(() => {
    if (!problem) return;
    boardRef.current?.fitCodeToSource(pseudocode);
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
      skeletonHash: skeletonHashRef.current,
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
      if (!board) return;
      const elements = board.getElements();
      const hash = sceneHash(elements);
      if (lastSavedHashRef.current === hash) return;
      const blob = board.saveBoard();
      void client.putBoard(problem.task_id, blob).then(() => {
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
    await client.putSolution(problem.task_id, pseudocodeRef.current);
  }, [client, problem]);

  const pickProblem = useCallback(
    async (taskId: string, bank?: SearchOptions) => {
      const fromBrowse = !problem;
      const switching = Boolean(problem);
      setActiveRegion("constraints");
      setBusy("loading the workspace…");
      setError(null);
      setReview(null);
      setTests(null);
      setBridge(null);
      setPrograms([]);
      setFrameByProgram({});
      setNudges([]);
      setCoachMessages([]);
      lastReviewIdsRef.current = new Set();
      reviewTurnRef.current = 0;
      lastStructureBaselineRef.current = null;
      lastPseudocodeHashRef.current = undefined;
      if (bank) setBankFilters(bank);
      if (fromBrowse) {
        setHoldBrowseOverlay(true);
        setBrowseMotion("busy");
      }
      if (switching) setSwitchMotion("busy");
      try {
        // Materialize the workspace on the PC, then read back the redacted
        // statement for the board template.
        await client.loadProblem(taskId);
        try {
          await client.enqueueSession(taskId);
        } catch {
          /* queue write is best-effort when not paired yet */
        }
        const detail = await client.getProblem(taskId);
        let source = detail.starter_code ?? "";
        try {
          const disk = await client.getSolution(taskId);
          if (disk.source.trim().length > 0) source = disk.source;
        } catch {
          // Fresh load — starter_code is fine.
        }
        source = ensureCodingRoom(source);

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
        skeletonHashRef.current = await sha256Hex(source);
        // Mount the board under the overlay / blur, but keep it invisible until
        // fit settles — then crossfade so the viewport does not jump.
        setBoardPreparing(true);
        setProblem(detail);
        await refreshSession();

        const skeletons = buildProblemTemplate({
          taskId: detail.task_id,
          title: titleFromSlug(detail.task_id),
          difficulty: detail.difficulty,
          tags: detail.tags,
          description: detail.problem_description,
          caseCount: detail.cases.length,
          dark: isDarkTheme(themeId),
        });

        let restoredBoard = false;
        try {
          const saved = await client.getBoard(taskId);
          const blob = saved.board as { v?: number; elements?: unknown[]; appState?: unknown } | null;
          if (blob && blob.v === 1 && Array.isArray(blob.elements) && blob.elements.length > 0) {
            boardRef.current?.restoreBoard(blob.elements, blob.appState, { skeletons });
            restoredBoard = true;
          }
        } catch {
          // Missing board.json is fine — seed a fresh template.
        }
        if (!restoredBoard) {
          boardRef.current?.seedTemplate(skeletons);
        }
        boardRef.current?.fitCodeToSource(source);
        lastIdsRef.current = new Set();

        await boardRef.current?.settleFitView();

        setBrowseMotion("idle");
        setSwitchMotion("idle");
        setHoldBrowseOverlay(false);
        setBoardPreparing(false);
        setEntering(true);
        window.setTimeout(() => {
          setEntering(false);
        }, boardFadeMs() || 1);
      } catch (cause) {
        setError(messageOf(cause));
        setHoldBrowseOverlay(false);
        setBoardPreparing(false);
        if (fromBrowse) setBrowseMotion("idle");
        setSwitchMotion("idle");
      } finally {
        setBusy(null);
      }
    },
    [client, themeId, problem, refreshSession],
  );

  /** Session queue when present; otherwise the filtered problem bank. */
  const stepProblem = useCallback(
    async (delta: number) => {
      if (!problem || busy !== null) return;
      const queue = session?.queue ?? [];
      const queueIndex = queue.indexOf(problem.task_id);
      if (queue.length > 0 && queueIndex >= 0) {
        const next = queue[queueIndex + delta];
        if (next) void pickProblem(next);
        return;
      }
      try {
        const adjacent = await client.adjacentProblems(problem.task_id, bankFilters);
        const next = delta < 0 ? adjacent.prev : adjacent.next;
        if (next) void pickProblem(next, bankFilters);
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [problem, busy, session, client, bankFilters, pickProblem],
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
      const queueIndex = queue.indexOf(problem.task_id);
      if (queue.length > 0 && queueIndex >= 0) {
        if (!cancelled) {
          setCanStepPrev(queueIndex > 0);
          setCanStepNext(queueIndex < queue.length - 1);
        }
        return;
      }
      try {
        const adjacent = await client.adjacentProblems(problem.task_id, bankFilters);
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
  }, [problem, session, bankFilters, client]);

  // Ambient mode's lifecycle.
  useEffect(() => {
    if (mode !== "ambient" || !problem) return;

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

  const pushCoachMessage = useCallback((role: CoachChatMessage["role"], content: string) => {
    setCoachMessages((current) => [
      ...current,
      { id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role, content, at: Date.now() },
    ]);
  }, []);

  const submitForReview = useCallback(async (studentNote?: string, includeBoard = true) => {
    const board = boardRef.current;
    if (!board || !problem) return;
    setBusy("asking the coach…");
    setError(null);
    setNotice(null);
    setCoachOpen(true);
    try {
      await syncSolution();
      const note = studentNote?.trim() ?? "";
      let payload;
      let capturedIds: Set<string> | null = null;
      if (includeBoard) {
        const snapshot = await buildSnapshot(board, recognizerRef.current, {
          pseudocode: pseudocodeRef.current,
          previousIds: lastReviewIdsRef.current,
          turnIndex: reviewTurnRef.current,
          includePng: modeHasVision("review"),
          structureBaseline: lastStructureBaselineRef.current,
          skeletonHash: skeletonHashRef.current,
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
        result = await client.review(problem.task_id, payload);
      } catch (cause) {
        // The picture is the first thing to give up: a board too big to buffer
        // must not cost the student the whole review.
        if (!("png" in payload) || !payload.png || !isBodyLimitError(cause)) throw cause;
        const { png: _png, ...withoutPng } = payload;
        result = await client.review(problem.task_id, withoutPng);
        setNotice(
          "the board image was too large to send — the coach reviewed your text and layout without it",
        );
      }
      setReview(result);
      pushCoachMessage("assistant", formatReviewMessage(result));
      // Baseline advances only on success — a failed review must not consume it.
      if (capturedIds) {
        lastReviewIdsRef.current = capturedIds;
        reviewTurnRef.current += 1;
        lastStructureBaselineRef.current = structureBaselineFromBoard(board.getElements());
        lastPseudocodeHashRef.current = await sha256Hex(pseudocodeRef.current);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, [client, problem, syncSolution, pushCoachMessage, modeHasVision]);

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
      const envelope = await client.viz(problem.task_id, snapshot.board, ask);
      const drawables = envelope.programs
        .map(parseVizProgram)
        .filter((candidate): candidate is VizProgram => candidate !== null)
        .slice(0, MAX_CONCURRENT_PROGRAMS);

      const api = sceneApi();
      if (api && drawables.length > 0) {
        for (const drawable of drawables) {
          applyViz(api, (skeletons) => board.convert(skeletons), drawable, 0);
        }
        setPrograms(drawables);
        setFrameByProgram(Object.fromEntries(drawables.map((program) => [program.id, 0])));
        pushCoachMessage(
          "assistant",
          drawables.length === 1
            ? "Drew a diagram on the board."
            : `Drew ${drawables.length} diagrams on the board.`,
        );
      }

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
  }, [client, problem, syncSolution, pushCoachMessage, modeHasVision, sceneApi]);

  const sendCoachChat = useCallback(
    (text: string, flags: CoachSendFlags) => {
      const flagBits = [
        flags.reviewBoard ? "Review board" : null,
        flags.draw ? "Draw" : null,
      ].filter(Boolean);
      const shown = [text, flagBits.length > 0 ? flagBits.join(" · ") : null]
        .filter(Boolean)
        .join("\n");
      pushCoachMessage("user", shown || "Send");
      void (async () => {
        if (flags.reviewBoard || text) {
          await submitForReview(text, flags.reviewBoard);
        }
        if (flags.draw) {
          await askForDiagram(text);
        }
      })();
    },
    [pushCoachMessage, submitForReview, askForDiagram],
  );

  const runTests = useCallback(async () => {
    if (!problem) return;
    setBusy("running the tests…");
    setError(null);
    try {
      await syncSolution();
      const result = await client.runTests(problem.task_id);
      setLastRunKind("run");
      setTests(result);
      setCoachOpen(true);
      await refreshSession();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, [client, problem, syncSolution, refreshSession]);

  const submitSolution = useCallback(async () => {
    if (!problem) return;
    setBusy("submitting…");
    setError(null);
    try {
      await syncSolution();
      const result = await client.runTests(problem.task_id);
      setLastRunKind("submit");
      setTests(result);
      setCoachOpen(true);
      await refreshSession();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, [client, problem, syncSolution, refreshSession]);

  const pickRandomProblem = useCallback(async () => {
    try {
      const next = await client.randomProblem(bankFilters);
      if (next) void pickProblem(next.task_id, bankFilters);
      else setError("no problems match the current filters");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [client, bankFilters, pickProblem]);

  const startFreshSession = useCallback(
    async (taskIds: string[] = []) => {
      try {
        let next = await client.resetSession();
        for (const id of taskIds) {
          next = await client.enqueueSession(id);
        }
        setSession(next);
        if (taskIds[0]) void pickProblem(taskIds[0], bankFilters);
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [client, pickProblem, bankFilters],
  );

  const resetSession = useCallback(async () => {
    if (!window.confirm("Reset the practice session? Queue and progress will be cleared.")) return;
    try {
      setSession(await client.resetSession());
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [client]);

  const startRandomSession = useCallback(
    async (filters: SearchOptions = bankFilters) => {
      try {
        setBankFilters(filters);
        const next = await client.randomSession({
          count: 5,
          difficulty: filters.difficulty,
          tag: filters.tag,
          q: filters.q,
        });
        setSession(next);
        const first = next.queue[0];
        if (first) void pickProblem(first, filters);
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [client, bankFilters, pickProblem],
  );

  const openInIde = useCallback(async () => {
    if (!problem) return;
    try {
      await client.openWorkspace(problem.task_id, "ide");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [client, problem]);

  // Deep link: ?task=<id> loads that problem once.
  useEffect(() => {
    if (deepLinkHandled.current || problem) return;
    const params = new URLSearchParams(window.location.search);
    const task = params.get("task");
    if (!task) return;
    deepLinkHandled.current = true;
    void pickProblem(task);
  }, [pickProblem, problem]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession, pairing]);

  const confirmReveal = useCallback(async () => {
    const board = boardRef.current;
    if (!problem) return;
    setRevealPending(true);
    setRevealError(null);
    try {
      const snapshot = board
        ? await buildSnapshot(board, recognizerRef.current, { pseudocode: pseudocodeRef.current })
        : null;
      // The `true` here is the only place the app asserts consent, and it is
      // reachable only from this dialog's Reveal button.
      const result = await client.reveal(
        problem.task_id,
        snapshot?.board ?? { recognized_text: "" },
        true,
      );
      setBridge(result);
      setRevealOpen(false);
    } catch (cause) {
      setRevealError(messageOf(cause));
    } finally {
      setRevealPending(false);
    }
  }, [client, problem]);

  const showFrame = useCallback(
    (programId: string, frameIndex: number) => {
      const api = sceneApi();
      const board = boardRef.current;
      const program = programs.find((entry) => entry.id === programId);
      if (!api || !board || !program) return;
      applyViz(api, (skeletons) => board.convert(skeletons), program, frameIndex);
      setFrameByProgram((current) => ({ ...current, [programId]: frameIndex }));
    },
    [programs, sceneApi],
  );

  const dismissProgram = useCallback(
    (programId?: string) => {
      const api = sceneApi();
      if (!api) return;
      if (programId) {
        removeViz(api, programId);
        setPrograms((current) => current.filter((program) => program.id !== programId));
        setFrameByProgram((current) => {
          const next = { ...current };
          delete next[programId];
          return next;
        });
        return;
      }
      clearAllViz(api);
      setPrograms([]);
      setFrameByProgram({});
    },
    [sceneApi],
  );

  const returnToBrowse = useCallback(() => {
    setBrowseMotion("enter");
    setActiveRegion("constraints");
    setProblem(null);
    setBoardPreparing(false);
    setHoldBrowseOverlay(false);
    setEntering(false);
    setReview(null);
    setTests(null);
    setBridge(null);
    setPrograms([]);
    setFrameByProgram({});
    setNudges([]);
    setError(null);
    setCodeSlot(null);
    lastReviewIdsRef.current = new Set();
    reviewTurnRef.current = 0;
    window.setTimeout(() => setBrowseMotion("idle"), slideDurationMs() || 1);
  }, []);

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
                onClick={returnToBrowse}
              >
                ← Problems
              </button>
              <div className="lc-problem-nav" role="group" aria-label="Problem">
                <button
                  type="button"
                  className="lc-icon"
                  title={
                    (session?.queue?.length ?? 0) > 0
                      ? "Previous in session queue"
                      : "Previous in problem bank"
                  }
                  aria-label="Previous problem"
                  disabled={!canStepPrev || busy !== null}
                  onClick={() => void stepProblem(-1)}
                >
                  ‹
                </button>
                <span className="lc-current" title={problem.task_id}>
                  {titleFromSlug(problem.task_id)}
                </span>
                <button
                  type="button"
                  className="lc-icon"
                  title={
                    (session?.queue?.length ?? 0) > 0
                      ? "Next in session queue"
                      : "Next in problem bank"
                  }
                  aria-label="Next problem"
                  disabled={!canStepNext || busy !== null}
                  onClick={() => void stepProblem(1)}
                >
                  ›
                </button>
              </div>
            </>
          ) : (
            <span className="lc-muted">pick a problem to start</span>
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
                ...(problem
                  ? [
                      {
                        id: "ide",
                        label: "Open in IDE",
                        disabled: busy !== null,
                        run: () => void openInIde(),
                      },
                    ]
                  : []),
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
          />
          {problem && mobile && (
            <RegionPager
              active={activeRegion}
              onPick={setActiveRegion}
              disabled={busy !== null || boardPreparing}
            />
          )}
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
                  onStartSession={(ids) => void startFreshSession(ids)}
                  onResetSession={() => void resetSession()}
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
            messages={coachMessages}
            onSend={sendCoachChat}
          >
            {mode === "ambient" && (
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

            {review && (
              <ReviewPanel
                review={review}
                onRequestBridge={() => {
                  setRevealError(null);
                  setRevealOpen(true);
                }}
                onDismiss={() => setReview(null)}
              />
            )}

            {programs.map((program) =>
              program.frames.length > 1 ? (
                <Timeline
                  key={program.id}
                  program={program}
                  onFrame={(frameIndex) => showFrame(program.id, frameIndex)}
                  onDismiss={() => dismissProgram(program.id)}
                />
              ) : null,
            )}
            {programs.length === 1 && programs[0].frames.length === 1 && (
              <button
                type="button"
                className="lc-secondary"
                onClick={() => dismissProgram(programs[0].id)}
              >
                Dismiss diagram
              </button>
            )}
            {programs.length > 1 && (
              <button type="button" className="lc-secondary" onClick={() => dismissProgram()}>
                Clear coach diagrams
              </button>
            )}

            {bridge && <BridgePanel bridge={bridge} onDismiss={() => setBridge(null)} />}

            {tests && (
              <TestSummary
                tests={tests}
                kind={lastRunKind}
                onDismiss={() => setTests(null)}
                onNext={() => void stepProblem(1)}
                onRandom={() => void pickRandomProblem()}
                onBrowse={returnToBrowse}
                canNext={canStepNext}
              />
            )}
          </AgentSidePanel>
        )}

      {revealOpen && problem && (
        <RevealDialog
          taskId={problem.task_id}
          onConfirm={() => void confirmReveal()}
          onCancel={() => setRevealOpen(false)}
          pending={revealPending}
          error={revealError}
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

function formatReviewMessage(review: ReviewResponse): string {
  const parts = [
    `Verdict: ${review.verdict.replace(/_/g, " ")}`,
    review.understood_approach ? `I think you're doing: ${review.understood_approach}` : null,
    review.gaps.length > 0 ? `Gaps:\n${review.gaps.map((g) => `• ${g}`).join("\n")}` : null,
    review.socratic_question ? `Question: ${review.socratic_question}` : null,
  ].filter(Boolean);
  return parts.join("\n\n");
}

function TestSummary({
  tests,
  kind,
  onDismiss,
  onNext,
  onRandom,
  onBrowse,
  canNext,
}: {
  tests: TestResponse;
  kind: "run" | "submit";
  onDismiss: () => void;
  onNext: () => void;
  onRandom: () => void;
  onBrowse: () => void;
  canNext: boolean;
}) {
  const failures = tests.results.filter((result) => !result.pass);
  const celebrate = kind === "submit" && tests.all_passed;
  return (
    <section className="lc-panel" aria-label="Test results">
      <header className="lc-panel-head">
        <strong className={tests.all_passed ? "lc-pass" : "lc-fail"}>
          {celebrate
            ? `All ${tests.total} cases passed`
            : `${tests.passed}/${tests.total} passed`}
        </strong>
        <button type="button" className="lc-link" onClick={onDismiss}>
          close
        </button>
      </header>
      {celebrate ? (
        <div className="lc-submit-pass">
          <p className="lc-muted">Nice work — pick where to go next.</p>
          <div className="lc-submit-actions">
            <button type="button" disabled={!canNext} onClick={onNext}>
              Next problem
            </button>
            <button type="button" className="lc-secondary" onClick={onRandom}>
              Random
            </button>
            <button type="button" className="lc-secondary" onClick={onBrowse}>
              Browse
            </button>
          </div>
        </div>
      ) : (
        <>
          {failures.slice(0, 5).map((result) => (
            <div key={result.case} className="lc-case-fail">
              <strong>case {result.case}</strong>
              <div>
                <code>{result.input}</code>
              </div>
              <div className="lc-muted">
                expected <code>{result.expected}</code>
                {result.actual !== null && (
                  <>
                    {" · got "}
                    <code>{result.actual}</code>
                  </>
                )}
              </div>
            </div>
          ))}
          {failures.length > 5 && <p className="lc-muted">…and {failures.length - 5} more</p>}
        </>
      )}
    </section>
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
