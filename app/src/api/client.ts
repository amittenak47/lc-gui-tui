/**
 * HTTP client for the `lc serve` daemon.
 *
 * One class, one `request` funnel, so the pairing token is attached in exactly
 * one place and the daemon's `{"error": "..."}` bodies surface as real messages
 * instead of "500".
 */

import type { Pairing } from "./pairing";
import { lcFetch } from "./nativeHttp";
import type {
  AdjacentProblems,
  AttemptOutcome,
  BoardSnapshot,
  BridgeResponse,
  CoachCapabilities,
  DatasetInfo,
  LcConfig,
  LlmStatus,
  LoadResponse,
  ProblemDetail,
  ProblemPage,
  ProblemSummary,
  ReviewResponse,
  SessionSnapshot,
  TestResponse,
  VizEnvelope,
  WorkspaceMeta,
} from "./types";

export class LcApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LcApiError";
  }

  /** True when the problem or its workspace simply isn't there yet. */
  get isMissing(): boolean {
    return this.status === 404;
  }
}

export interface SearchOptions {
  /** Problem set to search. Omitted means the default LeetCode corpus. */
  dataset?: string;
  difficulty?: string;
  tag?: string;
  q?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}

/** `?dataset=…` for a workspace route, or "" for the default corpus. */
function datasetSuffix(dataset?: string): string {
  return dataset ? `?dataset=${encodeURIComponent(dataset)}` : "";
}

export class LcClient {
  constructor(
    private pairing: Pairing,
    private readonly fetchImpl: typeof fetch = lcFetch,
  ) {}

  setPairing(pairing: Pairing): void {
    this.pairing = pairing;
  }

  async health(): Promise<{ ok: boolean; version: string; requires_token: boolean }> {
    return this.request("GET", "/health");
  }

  /** Paginated search against the daemon's SQLite index. */
  async searchProblems(options: SearchOptions = {}): Promise<ProblemPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      // `offset: 0` is meaningful, so only skip undefined and empty strings.
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return this.request("GET", `/problems${suffix ? `?${suffix}` : ""}`);
  }

  /** Every tag in one corpus, for the browser's filter. */
  async tags(dataset?: string): Promise<string[]> {
    return this.request("GET", `/tags${datasetSuffix(dataset)}`);
  }

  /** The tab strip: every problem set and how many problems it has indexed. */
  async datasets(): Promise<DatasetInfo[]> {
    return this.request("GET", "/datasets");
  }

  /** One random problem matching the filter — the TUI's `R`. */
  async randomProblem(options: SearchOptions = {}): Promise<ProblemSummary | null> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return this.request("GET", `/random${suffix ? `?${suffix}` : ""}`);
  }

  /** Practice session on disk (queue + progress). */
  async getSession(): Promise<SessionSnapshot> {
    return this.request("GET", "/session");
  }

  async resetSession(): Promise<SessionSnapshot> {
    return this.request("POST", "/session/reset");
  }

  async enqueueSession(taskId: string, dataset?: string): Promise<SessionSnapshot> {
    return this.request("POST", "/session/enqueue", { task_id: taskId, dataset });
  }

  async randomSession(options: {
    dataset?: string;
    count?: number;
    difficulty?: string;
    tag?: string;
    q?: string;
  } = {}): Promise<SessionSnapshot> {
    return this.request("POST", "/session/random", options);
  }

  /**
   * What to type on a tablet to pair with this daemon. Authenticated, so the
   * code is readable from the desktop app but not from the open LAN.
   */
  async pairCode(): Promise<{ code: string | null; host: string | null; port: number }> {
    return this.request("GET", "/pair/code");
  }

  async getConfig(): Promise<LcConfig> {
    return this.request("GET", "/config");
  }

  async putConfig(config: LcConfig): Promise<LcConfig> {
    return this.request("PUT", "/config", config);
  }

  async llmStatus(): Promise<LlmStatus> {
    return this.request("GET", "/llm/status");
  }

  async llmStart(): Promise<LlmStatus> {
    return this.request("POST", "/llm/start");
  }

  async llmStop(): Promise<LlmStatus> {
    return this.request("POST", "/llm/stop");
  }

  async openWorkspace(id: string, target: "ide" | "canvas", dataset?: string): Promise<{
    task_id: string;
    target: string;
    workspace_dir: string;
  }> {
    return this.request(
      "POST",
      `/workspace/${encodeURIComponent(id)}/open${datasetSuffix(dataset)}`,
      { target },
    );
  }

  /** Prev/next in the filtered problem bank (same order as the browser). */
  async adjacentProblems(id: string, options: SearchOptions = {}): Promise<AdjacentProblems> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return this.request(
      "GET",
      `/problems/${encodeURIComponent(id)}/adjacent${suffix ? `?${suffix}` : ""}`,
    );
  }

  async getProblem(id: string, dataset?: string): Promise<ProblemDetail> {
    return this.request("GET", `/problems/${encodeURIComponent(id)}${datasetSuffix(dataset)}`);
  }

  /** Materialize the workspace on the PC (README, solution.py, run_tests.py). */
  async loadProblem(id: string, dataset?: string): Promise<LoadResponse> {
    return this.request(
      "POST",
      `/problems/${encodeURIComponent(id)}/load${datasetSuffix(dataset)}`,
    );
  }

  async workspaceMeta(id: string, dataset?: string): Promise<WorkspaceMeta> {
    return this.request("GET", `/workspace/${encodeURIComponent(id)}/meta${datasetSuffix(dataset)}`);
  }

  async runTests(id: string, dataset?: string): Promise<TestResponse> {
    return this.request("POST", `/workspace/${encodeURIComponent(id)}/test${datasetSuffix(dataset)}`);
  }

  async getSolution(id: string, dataset?: string): Promise<{ task_id: string; source: string }> {
    return this.request(
      "GET",
      `/workspace/${encodeURIComponent(id)}/solution${datasetSuffix(dataset)}`,
    );
  }

  async putSolution(
    id: string,
    source: string,
    dataset?: string,
  ): Promise<{ task_id: string; source: string }> {
    return this.request(
      "PUT",
      `/workspace/${encodeURIComponent(id)}/solution${datasetSuffix(dataset)}`,
      { source },
    );
  }

  async getBoard(id: string, dataset?: string): Promise<{ task_id: string; board: unknown | null }> {
    return this.request("GET", `/workspace/${encodeURIComponent(id)}/board${datasetSuffix(dataset)}`);
  }

  async putBoard(
    id: string,
    board: unknown,
    dataset?: string,
  ): Promise<{ task_id: string; board: unknown | null }> {
    return this.request(
      "PUT",
      `/workspace/${encodeURIComponent(id)}/board${datasetSuffix(dataset)}`,
      { board },
    );
  }

  /** The coach transcript stored beside the workspace. */
  async getAgentSession(
    id: string,
    dataset?: string,
  ): Promise<{ task_id: string; dataset: string; messages: unknown[] }> {
    return this.request("GET", `/workspace/${encodeURIComponent(id)}/agent${datasetSuffix(dataset)}`);
  }

  async putAgentSession(
    id: string,
    messages: unknown[],
    dataset?: string,
  ): Promise<{ task_id: string; dataset: string; messages: unknown[] }> {
    return this.request(
      "PUT",
      `/workspace/${encodeURIComponent(id)}/agent${datasetSuffix(dataset)}`,
      { messages },
    );
  }

  /**
   * Leaving a problem: keep the work or clear it. The daemon owns the rules —
   * notably that a solved attempt always archives its layout and transcript so
   * the next attempt starts fresh.
   */
  async finishAttempt(
    id: string,
    options: { solved: boolean; save: boolean },
    dataset?: string,
  ): Promise<AttemptOutcome> {
    return this.request(
      "POST",
      `/workspace/${encodeURIComponent(id)}/attempt${datasetSuffix(dataset)}`,
      options,
    );
  }

  /** Per-mode provider / model / vision flags. */
  async capabilities(): Promise<CoachCapabilities> {
    return this.request("GET", "/coach/capabilities");
  }

  /** Mode A. The daemon validates any cited counterexample before replying. */
  async review(
    taskId: string,
    board: BoardSnapshot,
    dataset?: string,
    opts?: { layoutOnly?: boolean },
  ): Promise<ReviewResponse> {
    return this.request("POST", "/coach/review", {
      task_id: taskId,
      dataset,
      layout_only: opts?.layoutOnly === true,
      ...board,
    });
  }

  /**
   * Phase 4. The model replies with tool calls; the daemon drops any structure
   * it has no renderer for and any test case it cannot verify, so what comes
   * back is already safe to draw.
   */
  async viz(
    taskId: string,
    board: BoardSnapshot,
    ask = "",
    dataset?: string,
  ): Promise<VizEnvelope> {
    return this.request("POST", "/coach/viz", { task_id: taskId, dataset, board, ask });
  }

  /**
   * Phase 5. `confirmReveal` must come from the user's own confirmation, not a
   * default or a stored preference — the daemon rejects the call without it.
   */
  async reveal(
    taskId: string,
    board: BoardSnapshot,
    confirmReveal: boolean,
    dataset?: string,
    mode: "bridge" | "lazy" = "bridge",
  ): Promise<BridgeResponse> {
    return this.request("POST", "/coach/reveal", {
      task_id: taskId,
      dataset,
      confirm_reveal: confirmReveal,
      mode,
      board,
    });
  }

  /** Fill earned solution.py parts from the board only (no reference). */
  async lazyFill(
    taskId: string,
    board: BoardSnapshot,
    dataset?: string,
  ): Promise<import("./types").LazyFillResponse> {
    try {
      return await this.request("POST", "/coach/lazy", {
        task_id: taskId,
        dataset,
        board,
      });
    } catch (cause) {
      if (cause instanceof LcApiError && cause.status === 404) {
        throw new LcApiError(
          "Lazy fill needs a daemon that serves POST /coach/lazy — rebuild and restart `lc serve` (cargo install --path . if you use an installed binary)",
          404,
        );
      }
      throw cause;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.pairing.token) headers["X-LC-Token"] = this.pairing.token;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.pairing.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new LcApiError(
        `cannot reach lc serve at ${this.pairing.baseUrl} — is the daemon running, and are you on the same network?`,
        0,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new LcApiError(errorMessage(text, response.status), response.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** Prefer the daemon's own `{"error": ...}` message over a bare status line. */
function errorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
  } catch {
    // Not JSON — fall through.
  }
  return body.trim() || `request failed with status ${status}`;
}
