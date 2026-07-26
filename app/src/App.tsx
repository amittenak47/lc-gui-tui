/**
 * The whole loop, wired together.
 *
 * Two modes, per the plan:
 *
 * - **Review** — draw, tap Submit, get a verdict and a counterexample.
 * - **Ambient** — the coach glances at the board every 15 seconds and nudges,
 *   in the side panel only, never on the canvas.
 *
 * Both talk to `lc serve`. Nothing about the corpus, the workspaces, or the
 * Python runner lives on this device.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LcClient } from "./api/client";
import { AmbientCoach, type AmbientProbe } from "./api/coachSocket";
import { loadPairing, parsePairingUrl, savePairing, type Pairing } from "./api/pairing";
import type {
  BridgeResponse,
  ProblemDetail,
  ReviewResponse,
  ServerFrame,
  TestResponse,
} from "./api/types";
import { Board } from "./canvas/Board";
import type { BoardHandle } from "./canvas/BoardHandle";
import { sceneHash, studentElements } from "./canvas/capture";
import { MlKitRecognizer, NoopRecognizer, pickRecognizer, type InkRecognizer } from "./canvas/ink";
import { buildSnapshot } from "./canvas/snapshot";
import { AmbientPanel, type AmbientEntry } from "./modes/AmbientPanel";
import { ProblemBrowser } from "./modes/ProblemBrowser";
import { PseudocodeEditor } from "./modes/PseudocodeEditor";
import { BridgePanel, RevealDialog } from "./modes/RevealDialog";
import { ReviewPanel } from "./modes/ReviewPanel";
import { buildProblemTemplate } from "./templates/problemBoard";
import { titleFromSlug } from "./util/text";
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
  /** Recently opened problems, so prev/next works without re-searching. */
  const [history, setHistory] = useState<string[]>([]);

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
  // pseudocode editor would tear down and restart the 15-second loop.
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

  const pickProblem = useCallback(
    async (taskId: string) => {
      setBusy("loading the workspace…");
      setError(null);
      setReview(null);
      setTests(null);
      setBridge(null);
      setProgram(null);
      setNudges([]);
      setPseudocode("");
      try {
        // Materialize the workspace on the PC, then read back the redacted
        // statement for the board template.
        await client.loadProblem(taskId);
        const detail = await client.getProblem(taskId);
        setProblem(detail);
        setHistory((current) =>
          current.includes(detail.task_id) ? current : [...current, detail.task_id],
        );
        boardRef.current?.seedTemplate(
          buildProblemTemplate({
            taskId: detail.task_id,
            title: titleFromSlug(detail.task_id),
            difficulty: detail.difficulty,
            tags: detail.tags,
            description: detail.problem_description,
            caseCount: detail.cases.length,
          }),
        );
        lastIdsRef.current = new Set();
        // Fade the board in rather than cutting to it.
        setEntering(true);
        setTimeout(() => setEntering(false), 380);
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusy(null);
      }
    },
    [client],
  );

  /** Step through problems opened this session, without leaving the board. */
  const stepProblem = useCallback(
    (delta: number) => {
      if (!problem) return;
      const index = history.indexOf(problem.task_id);
      const next = history[index + delta];
      if (next) void pickProblem(next);
    },
    [problem, history, pickProblem],
  );

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
  }, [client, problem]);

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
      setTests(await client.runTests(problem.task_id));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, [client, problem]);

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

  return (
    <div className="lc-app">
      <header className="lc-header">
        <strong className="lc-brand">lc whiteboard</strong>
        {problem ? (
          <>
            {/* Problem identity and navigation, together on the left. */}
            <div className="lc-problem-nav" role="group" aria-label="Problem">
              <button
                type="button"
                className="lc-icon"
                title="Previous problem"
                aria-label="Previous problem"
                disabled={history.indexOf(problem.task_id) <= 0 || busy !== null}
                onClick={() => stepProblem(-1)}
              >
                ‹
              </button>
              <span className="lc-current" title={problem.task_id}>
                {problem.task_id}
              </span>
              <button
                type="button"
                className="lc-icon"
                title="Next problem"
                aria-label="Next problem"
                disabled={
                  history.indexOf(problem.task_id) >= history.length - 1 || busy !== null
                }
                onClick={() => stepProblem(1)}
              >
                ›
              </button>
              <button
                type="button"
                className="lc-link"
                onClick={() => setProblem(null)}
                disabled={busy !== null}
              >
                browse…
              </button>
            </div>

            <div className="lc-modes" role="group" aria-label="Coach mode">
              {(["review", "ambient"] as Mode[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={mode === value ? "lc-mode lc-mode-active" : "lc-mode"}
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                >
                  {value === "review" ? "Review" : "Ambient"}
                </button>
              ))}
            </div>

            {/* Coach actions on the right, grouped by what they talk to: the
                model first, then the test runner. `Clear` is not here — it
                changes the canvas, so it lives with the drawing tools. */}
            <div className="lc-actions">
              <div className="lc-action-group" role="group" aria-label="Ask the coach">
                {mode === "review" && (
                  <button type="button" onClick={() => void submitForReview()} disabled={busy !== null}>
                    Submit
                  </button>
                )}
                <button
                  type="button"
                  className="lc-secondary"
                  onClick={() => void askForDiagram()}
                  disabled={busy !== null}
                >
                  Draw it
                </button>
              </div>
              <div className="lc-action-group" role="group" aria-label="Workspace">
                <button
                  type="button"
                  className="lc-secondary"
                  onClick={() => void runTests()}
                  disabled={busy !== null}
                >
                  Run tests
                </button>
              </div>
            </div>
          </>
        ) : (
          <span className="lc-muted">pick a problem to start</span>
        )}
        <PairingBadge pairing={pairing} onPair={setPairing} />
      </header>

      {busy && <div className="lc-busy">{busy}</div>}
      {error && (
        <div className="lc-warning lc-banner">
          <span>{error}</span>
          <button type="button" className="lc-link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <main className="lc-main">
        <div className={entering ? "lc-canvas-wrap lc-entering" : "lc-canvas-wrap"}>
          <Board ref={boardRef} />
          {!problem && (
            <div className="lc-overlay">
              <ProblemBrowser client={client} onPick={pickProblem} busy={busy !== null} />
            </div>
          )}
        </div>

        <aside className="lc-side">
          <PseudocodeEditor value={pseudocode} onChange={setPseudocode} />
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

          {tests && <TestSummary tests={tests} onDismiss={() => setTests(null)} />}
        </aside>
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

function TestSummary({ tests, onDismiss }: { tests: TestResponse; onDismiss: () => void }) {
  const failures = tests.results.filter((result) => !result.pass);
  return (
    <section className="lc-panel" aria-label="Test results">
      <header className="lc-panel-head">
        <strong className={tests.all_passed ? "lc-pass" : "lc-fail"}>
          {tests.passed}/{tests.total} passed
        </strong>
        <button type="button" className="lc-link" onClick={onDismiss}>
          close
        </button>
      </header>
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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
