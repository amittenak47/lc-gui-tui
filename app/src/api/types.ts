/**
 * Wire types for the `lc serve` daemon.
 *
 * These mirror the DTOs in `src/serve/routes.rs` and the coach types in
 * `src/llm/coach.rs`. When one side changes, change both — the daemon is the
 * authority, and its Rust tests are what actually enforce the invariants
 * described here.
 */

export interface ProblemSummary {
  task_id: string;
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
  task_id: string;
  all_passed: boolean;
  passed: number;
  total: number;
  results: CaseResult[];
}

export interface SessionSnapshot {
  started_at: number;
  active_list: string | null;
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
  workspace_dir: string;
  python_executable: string;
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
  };
  serve_port: number;
  token_set: boolean;
}

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
  task_id: string;
  workspace_dir: string;
  case_count: number;
  meta: WorkspaceMeta;
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
  | { type: "error"; message: string };
