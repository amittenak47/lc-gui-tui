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
  BoardScaffold,
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

/** Cap how often failed fetches announce "server unreachable" to the UI. */
let lastUnreachableEventAt = 0;
const UNREACHABLE_EVENT_COOLDOWN_MS = 4_000;

function announceUnreachable(message: string): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  if (now - lastUnreachableEventAt < UNREACHABLE_EVENT_COOLDOWN_MS) return;
  lastUnreachableEventAt = now;
  window.dispatchEvent(new CustomEvent("lc-server-unreachable", { detail: message }));
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

export interface OfflinePackOptions {
  /** `0..1` with Content-Length; `-1` while indeterminate (building / proxy buffer). */
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Align with the daemon provider ceiling (`llm/providers/http.rs`). */
const COACH_HTTP_TIMEOUT_MS = 180_000;

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

  /** Resumable pack plan (no problem bodies). */
  async offlinePackManifest(): Promise<import("../util/offlinePackDownload").OfflinePackManifest> {
    return this.request("GET", "/offline/pack/manifest");
  }

  /** One page of problems for a resumable pack download. */
  async offlinePackChunk(options: {
    dataset: string;
    offset: number;
    limit?: number;
    since?: number;
  }): Promise<import("../util/offlinePackDownload").OfflinePackChunk> {
    const query = new URLSearchParams();
    query.set("dataset", options.dataset);
    query.set("offset", String(options.offset));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.since !== undefined) query.set("since", String(options.since));
    return this.request("GET", `/offline/pack/chunk?${query}`);
  }

  /** Task ids for one dataset — reconcile deletions on delta refresh. */
  async offlinePackDatasetKeys(options: {
    dataset: string;
    offset: number;
    limit?: number;
  }): Promise<import("../util/offlinePackDownload").OfflineDatasetKeys> {
    const query = new URLSearchParams();
    query.set("dataset", options.dataset);
    query.set("offset", String(options.offset));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return this.request("GET", `/offline/pack/keys?${query}`);
  }

  /**
   * Full offline problem pack (every indexed dataset except KodCode).
   * Prefer {@link offlinePackManifest} + {@link offlinePackChunk} for resumable downloads.
   *
   * {@link OfflinePackOptions.onProgress} receives `0..1` when Content-Length
   * is known, or `-1` while the total is unknown / the body is still buffering
   * (e.g. Tauri proxy). Closing the app or aborting leaves any prior pack intact.
   */
  async offlinePack(options: OfflinePackOptions = {}): Promise<import("../util/offlineCorpus").OfflinePack> {
    const { onProgress, signal } = options;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.pairing.token) headers["X-LC-Token"] = this.pairing.token;

    onProgress?.(-1);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.pairing.baseUrl}/offline/pack`, {
        method: "GET",
        headers,
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw new LcApiError("Download cancelled", 0);
      const message = `cannot reach lc serve at ${this.pairing.baseUrl} — is the daemon running, and are you on the same network?`;
      announceUnreachable(message);
      throw new LcApiError(message, 0);
    }

    if (!response.ok) {
      const rawText = await response.text();
      throw new LcApiError(errorMessage(rawText, response.status), response.status);
    }

    const total = Number(response.headers.get("content-length") || 0);
    const reader = response.body?.getReader?.();

    let rawText: string;
    if (!reader) {
      rawText = await response.text();
      onProgress?.(1);
    } else {
      const chunks: Uint8Array[] = [];
      let received = 0;
      if (total <= 0) onProgress?.(-1);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        received += value.length;
        if (total > 0) onProgress?.(Math.min(0.99, received / total));
        else onProgress?.(-1);
      }
      rawText = new TextDecoder().decode(concatBytes(chunks));
      onProgress?.(1);
    }

    return (rawText ? JSON.parse(rawText) : null) as import("../util/offlineCorpus").OfflinePack;
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

  async putConfig(
    config: LcConfig,
    opts?: { timeoutMs?: number },
  ): Promise<LcConfig> {
    return this.request("PUT", "/config", config, opts);
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
    opts?: { layoutOnly?: boolean; timeoutMs?: number },
  ): Promise<ReviewResponse> {
    return this.request(
      "POST",
      "/coach/review",
      {
        task_id: taskId,
        dataset,
        layout_only: opts?.layoutOnly === true,
        ...board,
      },
      { timeoutMs: opts?.timeoutMs ?? COACH_HTTP_TIMEOUT_MS },
    );
  }

  /**
   * Fresh-board region prompts for Approach / Complexity / Walkthrough.
   * Soft-fails on the client — load still seeds the generic template.
   */
  async scaffoldBoard(taskId: string, dataset?: string): Promise<BoardScaffold> {
    return this.request("POST", "/coach/scaffold", {
      task_id: taskId,
      dataset,
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
   * Look at a diagram the board already rendered, and redraw it once if the
   * picture does not say what the program claims. Refused by the daemon unless
   * `coach.draw_review_enabled` is on.
   */
  async drawReview(
    taskId: string,
    program: unknown,
    png: string,
    ask = "",
    dataset?: string,
  ): Promise<import("./types").DrawReviewEnvelope> {
    return this.request("POST", "/coach/draw_review", {
      task_id: taskId,
      dataset,
      program,
      png,
      ask,
    });
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

  /**
   * Single-turn Q&A — skips the staged review pipeline.
   *
   * `images` are base64 PNGs the student attached with (+). Omitted from the
   * body when there are none, so a daemon that predates the field sees exactly
   * the request it always saw.
   */
  async ask(
    question: string,
    opts: {
      surface: "whiteboard" | "annotate" | "problem";
      task_id?: string;
      dataset?: string;
      images?: string[];
      timeoutMs?: number;
    },
  ): Promise<{ task_id: string; provider: string; reply: string }> {
    const { surface, task_id, dataset, images, timeoutMs } = opts;
    const body: Record<string, unknown> = {
      surface,
      question,
      ...(task_id ? { task_id } : {}),
      ...(images && images.length > 0 ? { images } : {}),
    };
    if (surface === "problem") {
      body.dataset = dataset;
    }
    try {
      return await this.request(
        "POST",
        "/coach/ask",
        body,
        { timeoutMs: timeoutMs ?? COACH_HTTP_TIMEOUT_MS },
      );
    } catch (cause) {
      if (cause instanceof LcApiError && cause.status === 404) {
        throw new LcApiError(
          "Ask needs a daemon that serves POST /coach/ask — rebuild and restart `whiteboard serve`",
          404,
        );
      }
      throw cause;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.pairing.token) headers["X-LC-Token"] = this.pairing.token;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const timeoutMs = opts?.timeoutMs;
    const controller =
      timeoutMs != null && timeoutMs > 0 && typeof AbortController !== "undefined"
        ? new AbortController()
        : null;
    const timer =
      controller && timeoutMs != null
        ? window.setTimeout(() => controller.abort(), timeoutMs)
        : null;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.pairing.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch (cause) {
      if (timer != null) window.clearTimeout(timer);
      if (cause instanceof DOMException && cause.name === "AbortError") {
        throw new LcApiError(
          `lc serve did not answer ${method} ${path} within ${Math.round((timeoutMs ?? 0) / 1000)}s`,
          0,
        );
      }
      const message = `cannot reach lc serve at ${this.pairing.baseUrl} — is the daemon running, and are you on the same network?`;
      announceUnreachable(message);
      throw new LcApiError(message, 0);
    }
    if (timer != null) window.clearTimeout(timer);

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
