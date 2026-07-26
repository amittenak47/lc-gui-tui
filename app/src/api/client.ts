/**
 * HTTP client for the `lc serve` daemon.
 *
 * One class, one `request` funnel, so the pairing token is attached in exactly
 * one place and the daemon's `{"error": "..."}` bodies surface as real messages
 * instead of "500".
 */

import type { Pairing } from "./pairing";
import type {
  BoardSnapshot,
  BridgeResponse,
  LoadResponse,
  ProblemDetail,
  ProblemPage,
  ProblemSummary,
  ReviewResponse,
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
  difficulty?: string;
  tag?: string;
  q?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}

export class LcClient {
  constructor(
    private pairing: Pairing,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
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

  /** Every tag in the corpus, for the browser's filter. */
  async tags(): Promise<string[]> {
    return this.request("GET", "/tags");
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

  async getProblem(id: string): Promise<ProblemDetail> {
    return this.request("GET", `/problems/${encodeURIComponent(id)}`);
  }

  /** Materialize the workspace on the PC (README, solution.py, run_tests.py). */
  async loadProblem(id: string): Promise<LoadResponse> {
    return this.request("POST", `/problems/${encodeURIComponent(id)}/load`);
  }

  async workspaceMeta(id: string): Promise<WorkspaceMeta> {
    return this.request("GET", `/workspace/${encodeURIComponent(id)}/meta`);
  }

  async runTests(id: string): Promise<TestResponse> {
    return this.request("POST", `/workspace/${encodeURIComponent(id)}/test`);
  }

  async getSolution(id: string): Promise<{ task_id: string; source: string }> {
    return this.request("GET", `/workspace/${encodeURIComponent(id)}/solution`);
  }

  async putSolution(id: string, source: string): Promise<{ task_id: string; source: string }> {
    return this.request("PUT", `/workspace/${encodeURIComponent(id)}/solution`, { source });
  }

  /** Mode A. The daemon validates any cited counterexample before replying. */
  async review(taskId: string, board: BoardSnapshot): Promise<ReviewResponse> {
    return this.request("POST", "/coach/review", { task_id: taskId, ...board });
  }

  /**
   * Phase 4. The model replies with tool calls; the daemon drops any structure
   * it has no renderer for and any test case it cannot verify, so what comes
   * back is already safe to draw.
   */
  async viz(taskId: string, board: BoardSnapshot, ask = ""): Promise<VizEnvelope> {
    return this.request("POST", "/coach/viz", { task_id: taskId, board, ask });
  }

  /**
   * Phase 5. `confirmReveal` must come from the user's own confirmation, not a
   * default or a stored preference — the daemon rejects the call without it.
   */
  async reveal(
    taskId: string,
    board: BoardSnapshot,
    confirmReveal: boolean,
  ): Promise<BridgeResponse> {
    return this.request("POST", "/coach/reveal", {
      task_id: taskId,
      confirm_reveal: confirmReveal,
      board,
    });
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
