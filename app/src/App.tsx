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

import { LcClient, type SearchOptions } from "./api/client";
import { AmbientCoach, type AmbientProbe } from "./api/coachSocket";
import { loadPairing, parsePairingUrl, savePairing, type Pairing } from "./api/pairing";
import type {
  BridgeResponse,
  ProblemDetail,
  ReviewResponse,
  ServerFrame,
  SessionSnapshot,
  TestResponse,
} from "./api/types";
import { Tip } from "./components/Tip";
import { Board } from "./canvas/Board";
import type { BoardHandle, ScreenRect } from "./canvas/BoardHandle";
import { sceneHash, studentElements } from "./canvas/capture";
import { MlKitRecognizer, NoopRecognizer, pickRecognizer, type InkRecognizer } from "./canvas/ink";
import { buildSnapshot } from "./canvas/snapshot";
import { AgentSidePanel } from "./modes/AgentSidePanel";
import { AmbientPanel, type AmbientEntry } from "./modes/AmbientPanel";
import { ProblemBrowser } from "./modes/ProblemBrowser";
import { PseudocodeEditor } from "./modes/PseudocodeEditor";
import { BridgePanel, RevealDialog } from "./modes/RevealDialog";
import { ReviewPanel } from "./modes/ReviewPanel";
import { buildProblemTemplate } from "./templates/problemBoard";
import { titleFromSlug } from "./util/text";
import { applyAppTheme, isDarkTheme, loadThemeId, saveThemeId } from "./theme/appThemes";
import { Timeline } from "./viz/Timeline";
import { applyViz, clearAllViz, type SceneApi } from "./viz/apply";
import { parseVizProgram, type VizProgram } from "./viz/schema";

type Mode = "review" | "ambient";

export function App() {
  const [pairing, setPairing] = useState<Pairing>(() => loadPairing());
  const client = useMemo(() => new LcClient(pairing), [pairing]);

  const boardRef = useRef<BoardHandle | null>(null);
  const [recognizer, setRecognizer] = useState<InkRecognizer>(() => new NoopRecognizer());

  const [problem, setProblem] = useState<ProblemDetail | null>(null);
  const [mode, setMode] = useState<Mode>("review");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pseudocode, setPseudocode] = useState("");
  /** Drives the fade between the browser and the board. */
  const [entering, setEntering] = useState(false);
  /** Browser overlay: idle / enter / busy (spin) / exit (slide+spin) / done (check). */
  const [browseMotion, setBrowseMotion] = useState<"enter" | "idle" | "busy" | "exit" | "done">("idle");
  /** Active problem-bank filter — header prev/next walk this when there's no session queue. */
  const [bankFilters, setBankFilters] = useState<SearchOptions>({});
  /** Disk practice session from `lc serve` (queue + progress). */
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [canStepPrev, setCanStepPrev] = useState(false);
  const [canStepNext, setCanStepNext] = useState(false);
  /** Distinguishes header Run tests vs Submit for the results panel. */
  const [lastRunKind, setLastRunKind] = useState<"run" | "submit">("run");
  const [themeId, setThemeId] = useState(loadThemeId);
  const [coachOpen, setCoachOpen] = useState(false);
  const [codeSlot, setCodeSlot] = useState<ScreenRect | null>(null);

  const onCodeSlot = useCallback((next: ScreenRect | null) => {
    setCodeSlot((prev) => {
      if (prev === next) return prev;
      if (!prev || !next) return next;
      if (
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    applyAppTheme(themeId);
    saveThemeId(themeId);
  }, [themeId]);

  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [tests, setTests] = useState<TestResponse | null>(null);
  const [program, setProgram] = useState<VizProgram | null>(null);

  const [revealOpen, setRevealOpen] = useState(false);
  const [revealPending, setRevealPending] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [bridge, setBridge] = useState<BridgeResponse | null>(null);

  const [nudges, setNudges] = useState<AmbientEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [ambientProvider, setAmbientProvider] = useState<string | null>(null);
  const [lastSkip, setLastSkip] = useState<string | null>(null);

  /** Element ids at the last analysed board, for the stroke-delta check. */
  const lastIdsRef = useRef<Set<string>>(new Set());
  const coachRef = useRef<AmbientCoach | null>(null);
  // The recognizer can be swapped after mount; read it through a ref so the
  // ambient loop doesn't need to restart when it lands.
  const recognizerRef = useRef(recognizer);
  recognizerRef.current = recognizer;
  // Read through a ref for the same reason: otherwise every keystroke in the
  // pseudocode editor would tear down and restart the ambient loop.
  const pseudocodeRef = useRef(pseudocode);
  pseudocodeRef.current = pseudocode;

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
    let added = 0;
    for (const element of mine) {
      if (!lastIdsRef.current.has(element.id)) added += 1;
    }
    return {
      sceneHash: sceneHash(elements),
      newElements: added,
      hasContent: mine.length > 0,
    };
  }, []);

  /** Stage 2: recognition, only after stage 1 said the board changed. */
  const capture = useCallback(async () => {
    const board = boardRef.current;
    if (!board) return { recognized_text: "" };
    const snapshot = await buildSnapshot(board, recognizerRef.current, {
      pseudocode: pseudocodeRef.current,
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

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const syncSolution = useCallback(async () => {
    if (!problem) return;
    await client.putSolution(problem.task_id, pseudocodeRef.current);
  }, [client, problem]);

  const pickProblem = useCallback(
    async (taskId: string, bank?: SearchOptions) => {
      const fromBrowse = !problem;
      setBusy("loading the workspace…");
      setError(null);
      setReview(null);
      setTests(null);
      setBridge(null);
      setProgram(null);
      setNudges([]);
      if (bank) setBankFilters(bank);
      if (fromBrowse) setBrowseMotion("busy");
      try {
        // Materialize the workspace on the PC, then read back the redacted
        // statement for the board template.
        await client.loadProblem(taskId);
        const detail = await client.getProblem(taskId);
        let source = detail.starter_code ?? "";
        try {
          const disk = await client.getSolution(taskId);
          if (disk.source.trim().length > 0) source = disk.source;
        } catch {
          // Fresh load — starter_code is fine.
        }

        if (fromBrowse) {
          // Ready: keep the spinner, slide the browser away under the blur.
          setBrowseMotion("exit");
          await waitMs(slideDurationMs());
          // Spinner → checkmark, then a short beat before the board.
          setBrowseMotion("done");
          await waitMs(doneHoldMs());
        }

        setPseudocode(source);
        setProblem(detail);
        setBrowseMotion("idle");
        await refreshSession();
        boardRef.current?.seedTemplate(
          buildProblemTemplate({
            taskId: detail.task_id,
            title: titleFromSlug(detail.task_id),
            difficulty: detail.difficulty,
            tags: detail.tags,
            description: detail.problem_description,
            caseCount: detail.cases.length,
            dark: isDarkTheme(themeId),
          }),
        );
        lastIdsRef.current = new Set();
        setEntering(true);
        setTimeout(() => {
          setEntering(false);
          // Fit again after the enter fade so Excalidraw has final canvas size.
          boardRef.current?.fitView();
        }, boardFadeMs() || 1);
      } catch (cause) {
        setError(messageOf(cause));
        if (fromBrowse) setBrowseMotion("idle");
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

  // When the coach panel opens/closes, the canvas width changes — re-fit so
  // the problem page isn't clipped under the side panel.
  useEffect(() => {
    if (!problem) return;
    const timer = window.setTimeout(() => boardRef.current?.fitView(), 80);
    return () => window.clearTimeout(timer);
  }, [coachOpen, problem]);

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

  const submitForReview = useCallback(async () => {
    const board = boardRef.current;
    if (!board || !problem) return;
    setBusy("asking the coach…");
    setError(null);
    try {
      await syncSolution();
      const snapshot = await buildSnapshot(board, recognizerRef.current, { pseudocode: pseudocodeRef.current });
      if (snapshot.board.recognized_text.trim().length === 0) {
        setError(
          recognizerRef.current.name === "none"
            ? "nothing legible on the board — handwriting recognition needs the Android build, so type your approach with the text tool for now"
            : "nothing legible on the board yet",
        );
        return;
      }
      setReview(await client.review(problem.task_id, snapshot.board));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, [client, problem, syncSolution]);

  const askForDiagram = useCallback(async () => {
    const board = boardRef.current;
    if (!board || !problem) return;
    setBusy("drawing…");
    setError(null);
    try {
      const snapshot = await buildSnapshot(board, recognizerRef.current, { pseudocode: pseudocodeRef.current });
      const envelope = await client.viz(problem.task_id, snapshot.board);
      const drawable = envelope.programs
        .map(parseVizProgram)
        .find((candidate): candidate is VizProgram => candidate !== null);
      if (drawable) {
        setProgram(drawable);
      } else {
        setError(
          envelope.rejected[0] ??
            "the coach didn't produce a diagram — its model may not support tool calling",
        );
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, [client, problem]);

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
    (frameIndex: number) => {
      const api = sceneApi();
      const board = boardRef.current;
      if (!api || !board || !program) return;
      applyViz(api, (skeletons) => board.convert(skeletons), program, frameIndex);
    },
    [program, sceneApi],
  );

  const dismissProgram = useCallback(() => {
    const api = sceneApi();
    if (api) clearAllViz(api);
    setProgram(null);
  }, [sceneApi]);

  const returnToBrowse = useCallback(() => {
    setBrowseMotion("enter");
    setProblem(null);
    setReview(null);
    setTests(null);
    setBridge(null);
    setProgram(null);
    setNudges([]);
    setError(null);
    setCodeSlot(null);
    window.setTimeout(() => setBrowseMotion("idle"), slideDurationMs() || 1);
  }, []);

  return (
    <div className="lc-app">
      <header className="lc-header">
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
            {/* Problem identity and navigation, together on the left. */}
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
                {problem.task_id}
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

            <div className="lc-actions">
              <button
                type="button"
                className="lc-secondary"
                onClick={() => void runTests()}
                disabled={busy !== null}
              >
                Run tests
              </button>
              <button
                type="button"
                className="lc-secondary"
                onClick={() => void submitSolution()}
                disabled={busy !== null}
                title="Sync solution, run all tests, and continue if they pass"
              >
                Submit
              </button>
              <button
                type="button"
                className={coachOpen ? "lc-secondary lc-coach-toggle lc-coach-toggle-open" : "lc-secondary lc-coach-toggle"}
                aria-expanded={coachOpen}
                aria-controls="lc-coach-panel"
                onClick={() => setCoachOpen((current) => !current)}
              >
                Coach
              </button>
            </div>
          </>
        ) : (
          <span className="lc-muted">pick a problem to start</span>
        )}
        <div className="lc-header-center">
          <PairingBadge pairing={pairing} onPair={setPairing} />
        </div>
      </header>

      {busy && problem && <div className="lc-busy">{busy}</div>}
      {error && (
        <div className="lc-warning lc-banner">
          <span>{error}</span>
          <button type="button" className="lc-link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <main className="lc-main">
        <div
          className={
            entering
              ? "lc-canvas-wrap lc-entering"
              : problem
                ? "lc-canvas-wrap"
                : "lc-canvas-wrap lc-canvas-idle"
          }
        >
          <Board
            ref={boardRef}
            themeId={themeId}
            onThemePick={setThemeId}
            interactive={Boolean(problem)}
            onCodeSlot={onCodeSlot}
          />
          {!problem && (
            <div
              className={[
                "lc-overlay",
                browseMotion === "enter" && "lc-overlay-enter",
                browseMotion === "busy" && "lc-overlay-busy",
                browseMotion === "exit" && "lc-overlay-exit",
                browseMotion === "done" && "lc-overlay-done",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="lc-overlay-content">
                <ProblemBrowser
                  client={client}
                  onPick={pickProblem}
                  busy={busy !== null}
                  themeId={themeId}
                  onThemePick={setThemeId}
                />
              </div>
              {(browseMotion === "busy" ||
                browseMotion === "exit" ||
                browseMotion === "done") && (
                <div
                  className="lc-overlay-spinner"
                  role="status"
                  aria-live="polite"
                  aria-label={
                    browseMotion === "done" ? "Workspace ready" : "Loading workspace"
                  }
                >
                  {browseMotion === "done" ? (
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
            </div>
          )}
          {problem && (
            <div
              className={
                codeSlot && codeSlot.width > 24 && codeSlot.height > 24
                  ? "lc-code-dock"
                  : "lc-code-dock lc-code-dock-fallback"
              }
              style={
                codeSlot && codeSlot.width > 24 && codeSlot.height > 24
                  ? {
                      left: codeSlot.left,
                      top: codeSlot.top,
                      width: codeSlot.width,
                      height: codeSlot.height,
                    }
                  : undefined
              }
            >
              <PseudocodeEditor
                key={problem.task_id}
                value={pseudocode}
                onChange={setPseudocode}
                themeId={themeId}
                defaultOpen
                variant="dock"
              />
            </div>
          )}
        </div>

        {problem && (
          <AgentSidePanel
            open={coachOpen}
            mode={mode}
            onModeChange={setMode}
            busy={busy !== null}
            onSubmit={() => void submitForReview()}
            onDiagram={() => void askForDiagram()}
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

            {program && <Timeline program={program} onFrame={showFrame} onDismiss={dismissProgram} />}

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
      </main>

      {revealOpen && problem && (
        <RevealDialog
          taskId={problem.task_id}
          onConfirm={() => void confirmReveal()}
          onCancel={() => setRevealOpen(false)}
          pending={revealPending}
          error={revealError}
        />
      )}
    </div>
  );
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

function PairingBadge({
  pairing,
  onPair,
}: {
  pairing: Pairing;
  onPair: (pairing: Pairing) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pairing.baseUrl);
  const [problem, setProblem] = useState<string | null>(null);

  if (!editing) {
    return (
      <button
        type="button"
        className="lc-link lc-pairing"
        title={pairing.token ? "paired" : "loopback"}
        onClick={() => setEditing(true)}
      >
        {hostOf(pairing.baseUrl)}
      </button>
    );
  }

  return (
    <form
      className="lc-pairing-form"
      onSubmit={(event) => {
        event.preventDefault();
        // Accept either the full QR payload or a bare host:port.
        const parsed = parsePairingUrl(draft) ?? parsePairingUrl(`http://${draft}`);
        if (!parsed) {
          setProblem("that doesn't look like the URL `lc serve --lan` printed");
          return;
        }
        savePairing(parsed);
        onPair(parsed);
        setEditing(false);
        setProblem(null);
      }}
    >
      <input
        value={draft}
        aria-label="Daemon URL"
        placeholder="http://192.168.1.20:7878?token=…"
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="submit">Pair</button>
      <button type="button" className="lc-link" onClick={() => setEditing(false)}>
        cancel
      </button>
      {problem && <span className="lc-warning">{problem}</span>}
    </form>
  );
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
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
