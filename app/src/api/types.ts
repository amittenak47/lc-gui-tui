/**
 * Wire types for the `lc serve` daemon.
 *
 * These mirror the DTOs in `src/serve/routes.rs` and the coach types in
 * `src/llm/coach.rs`. When one side changes, change both — the daemon is the
 * authority, and its Rust tests are what actually enforce the invariants
 * described here.
 */

/**
 * One problem set. Datasets live in separate tables on the daemon, so a slug
 * travels with every id that crosses the wire — `two-sum` exists in three of
 * them and means something different in each.
 */
export interface DatasetInfo {
  id: string;
  label: string;
  /** Hugging Face repo the corpus came from. */
  source: string;
  /** Problems indexed. Zero means the corpus has not been downloaded yet. */
  count: number;
  corpus_dir: string | null;
  /** What this corpus's columns mean — shown on the tab. Older daemons omit it. */
  notes?: string;
}

export const DEFAULT_DATASET = "leetcode";

export interface ProblemSummary {
  dataset: string;
  task_id: string;
  /** `dataset/task_id` — how session progress is keyed. */
  key: string;
  question_id: string | null;
  difficulty: string | null;
  tags: string[];
  test_count: number;
}

/** A page of search results plus the totals needed to render "page 3 of 41". */
export interface ProblemPage {
  items: ProblemSummary[];
  /** Matches across the whole filter, not just this page. */
  total: number;
  offset: number;
  limit: number;
}

export interface IoCase {
  input: string;
  output: string;
}

/**
 * The redacted problem. There is deliberately no field for the corpus's
 * reference solution: `Problem` in the daemon cannot even deserialize one.
 */
export interface ProblemDetail {
  dataset: string;
  key: string;
  task_id: string;
  question_id: string | null;
  difficulty: string | null;
  tags: string[];
  problem_description: string | null;
  starter_code: string | null;
  entry_point: string | null;
  cases: IoCase[];
}

export interface WorkspaceMeta {
  dataset: string;
  task_id: string;
  question_id: string | null;
  difficulty: string | null;
  tags: string[];
  entry_point: string | null;
  json_path: string;
  cases: IoCase[];
  test: string | null;
}

export interface CaseResult {
  case: number;
  pass: boolean;
  input: string;
  expected: string;
  actual: string | null;
  error: string | null;
  stdout: string | null;
  suite: boolean;
}

export interface TestResponse {
  dataset: string;
  task_id: string;
  all_passed: boolean;
  passed: number;
  total: number;
  results: CaseResult[];
  /** The run stopped at the first failure because Settings → Tests says to. */
  stopped_early: boolean;
}

export interface SessionSnapshot {
  started_at: number;
  active_list: string | null;
  /** `dataset/task_id` keys, not bare task ids. */
  queue: string[];
  problems: Record<
    string,
    {
      state: "loaded" | "passed" | "failed";
      passed_cases: number;
      total_cases: number;
      updated_at: number;
    }
  >;
  reveals: Record<string, number>;
  stats?: {
    loaded: number;
    passed: number;
    failed: number;
    reveals: number;
    queue_len: number;
  };
}

export interface ProviderConfig {
  base_url: string;
  model: string;
  vision_model: string;
}

export interface LcConfig {
  data_json_dir: string | null;
  /** Per-dataset corpus folder overrides, keyed by dataset slug. */
  dataset_dirs: Record<string, string>;
  workspace_dir: string;
  python_executable: string;
  /** Settings → Tests: stop at the first failing case instead of running all. */
  stop_on_first_failure: boolean;
  default_provider: string;
  local: ProviderConfig;
  ollama: ProviderConfig;
  openai: ProviderConfig;
  groq: ProviderConfig;
  modes: {
    ambient: string;
    review: string;
    bridge: string;
    viz: string;
    /** Frontier plans the approaches; the local executor coaches. */
    planner: string;
  };
  serve_port: number;
  /** Streaming-coach feature flags. Absent on a daemon older than Phase 1. */
  coach?: CoachFlags;
  token_set: boolean;
}

/** Settings → Coach. Mirrors `CoachConfig` in `src/config.rs`. */
export interface CoachFlags {
  /** Drive Ask/Review/Draw/Lazy over the socket instead of blocking POSTs. */
  ws_runs: boolean;
  /** Show per-stage process blocks in the chat thread. */
  process_events_ui: boolean;
  planner_enabled: boolean;
  draw_review_enabled: boolean;
  approach_commitment: boolean;
}

export const DEFAULT_COACH_FLAGS: CoachFlags = {
  ws_runs: true,
  process_events_ui: true,
  planner_enabled: false,
  draw_review_enabled: false,
  approach_commitment: true,
};

export interface LlmStatus {
  running: boolean;
  base_url: string;
  pid: number | null;
  owned: boolean;
  detail: string;
}

export interface AdjacentProblems {
  task_id: string;
  prev: string | null;
  next: string | null;
}

export interface LoadResponse {
  dataset: string;
  task_id: string;
  workspace_dir: string;
  case_count: number;
  meta: WorkspaceMeta;
  resume: ResumeState;
}

/** What a previous visit to this workspace left behind. */
export interface ResumeState {
  attempt: AttemptState;
  /** Saved whiteboard, or null when the next attempt starts fresh. */
  board: unknown | null;
  /** Saved coach transcript, empty when the next attempt starts fresh. */
  agent_messages: unknown[];
}

export interface AttemptState {
  /** Every case passed here at least once. */
  solved: boolean;
  /** The student kept their work when they last stepped away. */
  saved: boolean;
  archives: string[];
  updated_at: number;
}

/** What the daemon did with the save-or-discard choice. */
export interface AttemptOutcome {
  solved: boolean;
  saved: boolean;
  kept_layout: boolean;
  kept_code: boolean;
  kept_agent_session: boolean;
  archived_to: string | null;
  state: AttemptState;
}

/** One captured board state, as `POST /coach/review` and the WS expect it. */
export interface BoardSnapshot {
  recognized_text: string;
  scene_structure?: unknown;
  /** Base64 PNG, only sent when the selected model is vision-capable. */
  png?: string;
  /**
   * Typed pseudocode. Kept separate from `recognized_text` because it is exact,
   * and the daemon tells the model to read it literally rather than second-
   * guessing it the way it must with handwriting.
   */
  pseudocode?: string;
  /** Truncated element ids added since the last successful review. */
  new_since_last?: string[];
  /** Successful review count this session (0 = first look). */
  turn_index?: number;
  scene_hash?: number;
  board_ops?: unknown[];
  ink_ops_len?: number;
  code_mode?: "full" | "delta" | "unchanged";
  skeleton_hash?: string;
  pseudocode_delta?: string;
  /**
   * Messages from the app, not the student — currently the last test run. Its
   * own channel because the daemon tells the coach to read these as fact,
   * unlike anything on the board.
   */
  app_messages?: string[];
}

export type Verdict = "on_track" | "subtly_wrong" | "wrong_track" | "unclear";

export interface Counterexample {
  /** 0-based index into `WorkspaceMeta.cases`, validated by the daemon. */
  case_index: number;
  /** 1-based, matching `lc test --case N`. */
  case_number: number;
  input: string;
  expected: string;
  why_your_approach_fails: string;
}

/** One approach family, as the planner catalogued it. Never a solution. */
export interface ApproachCandidate {
  id: string;
  name: string;
  when_to_use: string;
  strengths: string[];
  weaknesses: string[];
  sketch_steps: string[];
}

/** A recorded move from one committed approach to another, with its reason. */
export interface ApproachTransition {
  from: string;
  to: string;
  reason: string;
  what_carries_over?: string[];
}

export interface ReviewResponse {
  task_id: string;
  provider: string;
  understood_approach: string;
  verdict: Verdict;
  rating: { correctness: number; complexity: number; clarity: number };
  strengths: string[];
  gaps: string[];
  counterexample: Counterexample | null;
  socratic_question: string;
  offer_bridge: boolean;
  /**
   * Set when the coach cited a case index that does not exist. The daemon drops
   * the citation rather than showing a fabricated case.
   */
  counterexample_rejected: string | null;
  /** Present when layout and code were scored in separate LLM passes. */
  layout_verdict?: Verdict | null;
  code_verdict?: Verdict | null;
  /**
   * Set when this review moved the session's committed approach. The daemon
   * only sends it for a board that actually changed — a model that merely read
   * the same drawing differently is held to the commitment and says nothing.
   */
  approach_transition?: ApproachTransition | null;
  /**
   * Approaches the board could equally be arguing for. Offered as choices, not
   * applied: picking one is a message the student sends.
   */
  candidate_approaches?: ApproachCandidate[];
}

export interface BridgeStep {
  title: string;
  detail: string;
}

export interface BridgeResponse {
  task_id: string;
  provider: string;
  reveal_count: number;
  already_yours: string;
  missing_piece: string;
  steps: BridgeStep[];
  smallest_edit: string;
  /** Lazy hint mode — full solution.py to write into the editor. */
  filled_code?: string | null;
  lazy_note?: string | null;
}

export interface LazyFillResponse {
  task_id: string;
  provider: string;
  filled_code: string;
  note: string;
}

/** Problem-specific empty-region prompts from `POST /coach/scaffold`. */
export interface BoardScaffold {
  approach: string;
  complexity: string;
  walkthrough: string;
  provider?: string;
  task_id?: string;
}

export interface Annotation {
  region: string;
  text: string;
  tone: string;
}

/** A sample case the coach pointed at, already validated by the daemon. */
export interface Citation {
  case_index: number;
  case_number: number;
  input: string;
  expected: string;
  why: string;
}

/** Read-only overlay pointing at student elements. */
export interface Highlight {
  ids: string[];
  tone: string;
  note: string;
}

export interface VizEnvelope {
  task_id: string;
  provider: string;
  /** Raw viz programs; run each through `parseVizProgram` before rendering. */
  programs: unknown[];
  annotations: Annotation[];
  citations: Citation[];
  highlights?: Highlight[];
  message: string;
  /** Tool calls the daemon dropped as unrenderable or unverifiable. */
  rejected: string[];
}

/** One structured critique of a diagram the client already rendered. */
export interface DrawReviewEnvelope {
  task_id: string;
  provider: string;
  /** Whether the diagram is good enough to leave alone. */
  ok: boolean;
  issues: string[];
  fix_hint: string;
  /** A replacement program under the same id, when the redraw produced one. */
  program?: unknown;
  /** Why no vision check ran. Shown as a process line, not an error. */
  skipped?: string | null;
}

export interface ModeCapability {
  mode: string;
  provider: string;
  model: string;
  vision: boolean;
}

export interface CoachCapabilities {
  modes: ModeCapability[];
}

export interface AmbientNudge {
  confidence: number;
  guessed_approach: string;
  closeness: string;
  nudge: string;
}

/** What an interactive `run` frame asks the coach to do. */
export type RunAction = "ask" | "review" | "viz" | "lazy" | "draw_review";

/**
 * Stages the daemon reports, in roughly the order they can occur. The daemon is
 * free to send a name not in this list — the UI falls back to the `detail`
 * string — but these are the ones it labels itself.
 */
export const STAGE_LABELS: Record<string, string> = {
  received: "Got it",
  perceive: "Reading the board",
  claim: "Naming the approach",
  commit_approach: "Sticking with the approach",
  plan_approaches: "Planning approaches",
  verdict: "Checking the cases",
  code: "Reading solution.py",
  retrace: "Re-tracing the cited case",
  ask: "Thinking…",
  lazy: "Writing the earned code",
  draw_tools: "Choosing what to draw",
  validate: "Checking the diagram schema",
  draw_review: "Looking at what it drew",
  draw_fix: "Redrawing",
  done: "Done",
};

/** One line in a chat turn's process block. */
export interface CoachProcessEvent {
  kind: "stage" | "tool";
  /** Stage name, or tool name for a tool event. */
  label: string;
  detail?: string;
  /** Tool events only. */
  status?: "proposed" | "accepted" | "rejected";
  ts: number;
}

/** Frames the daemon sends on `WS /coach/session`. */
export type ServerFrame =
  | {
      type: "ready";
      session_id: string;
      task_id: string;
      provider: string;
      nudges_so_far: number;
    }
  | { type: "skipped"; reason: string }
  | { type: "thinking" }
  | ({ type: "nudge"; nudges_so_far: number } & AmbientNudge)
  | { type: "stage"; request_id: string; stage: string; detail: string }
  | {
      type: "tool_event";
      request_id: string;
      name: string;
      status: "proposed" | "accepted" | "rejected";
      summary: string;
      reason?: string | null;
    }
  | { type: "result"; request_id: string; action: RunAction; body: unknown }
  /**
   * `request_id` is what routes a failure: present means it belongs to a chat
   * turn, absent means the ambient loop hit it and no turn is waiting.
   */
  | { type: "error"; request_id?: string | null; message: string };
