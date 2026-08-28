/**
 * Client for the bundled harness. Named Tauri `invoke`s — no URL, no dummy host.
 */

import { b64ToBytes, bytesToB64, loadInvoke, readInvokeResult } from "./nativeHttp";
import { loadPadHub, type PadHub } from "../util/padHub";
import type {
  AdjacentProblems,
  AttemptOutcome,
  BoardSnapshot,
  BridgeResponse,
  CoachCapabilities,
  DatasetInfo,
  LcConfig,
  LcConfigPut,
  LlmStatus,
  LoadResponse,
  ModelCatalog,
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

export interface ProposedAnnotation {
  excerpt: string;
  note: string;
  tags?: string[];
  page?: number;
  links?: string[];
}

export interface DocIndexStatus {
  hash: string;
  indexed: boolean;
  page_count: number;
  chunk_count: number;
  embedded: boolean;
  /** The model that produced these vectors, or empty if none did. */
  embed_model?: string;
  chunks_total?: number;
  chunks_embedded?: number;
  /**
   * `none` | `partial` | `full`.
   *
   * A document embedded under a *different* model reads `none`, not `partial`:
   * vectors from two models cannot be ranked against each other, so it is work
   * to redo rather than work half done.
   */
  embed_state?: "none" | "partial" | "full";
  /** Why it is not `full` — `pending`, no model, or a named model mismatch. */
  reason?: string;
  /** What is configured now, so a mismatch can name both sides. */
  configured_model?: string;
}

/** How far the embedding pass has got, and why it stopped if it did. */
export interface DocEmbedProgress {
  done: number;
  total: number;
  reason?: string;
}

export interface DocChunkRecord {
  page: number;
  ordinal: number;
  heading?: string;
  text_hash: string;
  embedded: number;
  embedding: string;
}

export interface DocChunkBundle {
  hash: string;
  embed_model: string;
  chunks: DocChunkRecord[];
}

/** One passage, and the book it lives in. */
export interface LibraryHit {
  hash: string;
  name: string;
  page: number;
  heading?: string;
  text: string;
  score: number;
}

/**
 * What was searched and what was not — never implied, always stated.
 *
 * `summary` is the sentence the server already composed, so the rule about
 * what counts as searchable lives in one place rather than being re-derived
 * here and drifting.
 */
export interface LibraryScope {
  searched: number;
  total: number;
  skipped: string[];
  lexical: boolean;
}

export interface LibraryAnswer {
  chunks: LibraryHit[];
  scope: LibraryScope;
  summary: string;
}

export interface DocChunkMergeAck {
  applied: boolean;
  updated: number;
  reason?: string;
}

export interface DocChunkDigest {
  hash: string;
  embed_model: string;
  chunks_total: number;
  chunks_embedded: number;
}

export class LcApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText?: string,
    readonly json?: unknown,
  ) {
    super(message);
    this.name = "LcApiError";
  }

  /** True when the problem or its workspace simply isn't there yet. */
  get isMissing(): boolean {
    return this.status === 404;
  }
}

let lastUnreachableEventAt = 0;
const UNREACHABLE_EVENT_COOLDOWN_MS = 4_000;

function announceUnreachable(message: string): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  if (now - lastUnreachableEventAt < UNREACHABLE_EVENT_COOLDOWN_MS) return;
  lastUnreachableEventAt = now;
  window.dispatchEvent(new CustomEvent("lc-server-unreachable", { detail: message }));
}

async function hubFetch(
  hub: PadHub,
  method: string,
  path: string,
  init?: { json?: unknown; bytes?: ArrayBuffer },
): Promise<{ json: unknown; bytes: ArrayBuffer }> {
  const url = `${hub.url}${path}`;
  const headers: Record<string, string> = { "x-lc-token": hub.token };
  let body: BodyInit | undefined;
  if (init?.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init?.bytes) {
    headers["content-type"] = "application/octet-stream";
    body = init.bytes;
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    announceUnreachable(message);
    throw new LcApiError(message, 0);
  }
  const bytes = await res.arrayBuffer();
  let json: unknown = null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) {
    try {
      json = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const errBody =
      json && typeof json === "object" && json !== null && "error" in json
        ? String((json as { error: unknown }).error)
        : json != null
          ? JSON.stringify(json)
          : new TextDecoder().decode(bytes);
    throw new LcApiError(errBody || res.statusText, res.status, errBody, json);
  }
  return { json, bytes };
}

/** Hub-only JSON round trip for the doc routes; throws on any non-2xx. */
async function hubJson<T>(
  hub: PadHub,
  method: string,
  path: string,
  json?: unknown,
): Promise<T> {
  const { json: body } = await hubFetch(
    hub,
    method,
    path,
    json !== undefined ? { json } : undefined,
  );
  return body as T;
}

function parseChunkBundle(hash: string, raw: unknown): DocChunkBundle {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const chunks = Array.isArray(row.chunks)
    ? row.chunks.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const chunk = entry as Record<string, unknown>;
        if (typeof chunk.page !== "number" || typeof chunk.ordinal !== "number") return [];
        if (typeof chunk.text_hash !== "string") return [];
        return [
          {
            page: chunk.page,
            ordinal: chunk.ordinal,
            heading: typeof chunk.heading === "string" ? chunk.heading : undefined,
            text_hash: chunk.text_hash,
            embedded: typeof chunk.embedded === "number" ? chunk.embedded : 0,
            embedding: typeof chunk.embedding === "string" ? chunk.embedding : "",
          } satisfies DocChunkRecord,
        ];
      })
    : [];
  return {
    hash: typeof row.hash === "string" && row.hash ? row.hash : hash,
    embed_model: typeof row.embed_model === "string" ? row.embed_model : "",
    chunks,
  };
}

function parseChunkMergeAck(raw: unknown): DocChunkMergeAck {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    applied: row.applied !== false,
    updated: typeof row.updated === "number" ? row.updated : 0,
    reason: typeof row.reason === "string" ? row.reason : undefined,
  };
}

function parseChunkDigests(raw: unknown): DocChunkDigest[] {
  if (!Array.isArray(raw)) return [];
  const out: DocChunkDigest[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.hash !== "string" || !row.hash) continue;
    out.push({
      hash: row.hash,
      embed_model: typeof row.embed_model === "string" ? row.embed_model : "",
      chunks_total: typeof row.chunks_total === "number" ? row.chunks_total : 0,
      chunks_embedded: typeof row.chunks_embedded === "number" ? row.chunks_embedded : 0,
    });
  }
  return out;
}

/**
 * What a pad hub answered when asked, in the two ways it can go wrong.
 *
 * `unreachable` is the address: nothing at that host and port, or the PC is on
 * another network. `code` is the six digits: something answered, and refused.
 * Saving the pair alone cannot tell those apart, which is how a wrong address
 * and a wrong code look like the same silence.
 */
export type PadHubCheck =
  | { ok: true; version: string }
  | { ok: false; reason: "unreachable" | "code"; detail: string };

const PAD_HUB_CHECK_TIMEOUT_MS = 6_000;

async function probe(url: string, headers?: Record<string, string>): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PAD_HUB_CHECK_TIMEOUT_MS);
  try {
    return await fetch(url, { method: "GET", headers, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask a pad hub whether this device can actually reach it.
 *
 * Deliberately not routed through {@link hubFetch}: this is a test the reader
 * asked for, so a failure belongs in the answer rather than in the app-wide
 * "server unreachable" banner.
 */
export async function checkPadHub(hub: PadHub): Promise<PadHubCheck> {
  const base = hub.url.replace(/\/+$/, "");
  let health: Response;
  try {
    health = await probe(`${base}/health`);
  } catch (cause) {
    const detail = cause instanceof Error && cause.name === "AbortError"
      ? "no answer within six seconds"
      : cause instanceof Error
        ? cause.message
        : String(cause);
    return { ok: false, reason: "unreachable", detail };
  }
  if (!health.ok) {
    return { ok: false, reason: "unreachable", detail: `the PC answered ${health.status}` };
  }
  let version = "";
  try {
    const body = (await health.json()) as { version?: unknown };
    if (typeof body.version === "string") version = body.version;
  } catch {
    // A hub that answers /health without JSON is still a hub.
  }

  // `/health` sits outside the token check on purpose, so reaching it proves
  // the address and says nothing about the code. One authenticated call is what
  // separates them.
  let auth: Response;
  try {
    auth = await probe(`${base}/config`, { "x-lc-token": hub.token });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: "unreachable", detail };
  }
  if (auth.status === 401 || auth.status === 403) {
    return { ok: false, reason: "code", detail: "the PC refused this code" };
  }
  if (!auth.ok) {
    return { ok: false, reason: "unreachable", detail: `the PC answered ${auth.status}` };
  }
  return { ok: true, version };
}

async function padInvokeOrHub<T>(
  invoke: () => Promise<T>,
  method: string,
  path: string,
  json?: unknown,
): Promise<T> {
  const hub = loadPadHub();
  if (!hub) return invoke();
  const { json: body } = await hubFetch(
    hub,
    method,
    path,
    json !== undefined ? { json } : undefined,
  );
  return body as T;
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

/** Align with the daemon provider ceiling (`llm/providers/http.rs`). */
const COACH_HTTP_TIMEOUT_MS = 180_000;

export interface WhiteboardPadDto {
  id: string;
  title: string;
  updated_at: number;
  page_count: number;
  deleted_at?: number | null;
  sync_seq?: number;
  base_updated_at?: number | null;
  board: unknown;
  agent: unknown;
}

export interface AnnotatePadDto {
  id: string;
  name: string;
  hash: string;
  doc_type: string;
  updated_at: number;
  deleted_at?: number | null;
  sync_seq?: number;
  base_updated_at?: number | null;
  source: string;
  footnotes: unknown;
  board: unknown;
  agent: unknown;
}

export interface PadSnapshotDto {
  kind: string;
  key: string;
  tier: string;
  written_at: number;
  payload: unknown;
}

export interface PadGoneDto {
  kind: string;
  id: string;
  seq: number;
  gone_at: number;
}

export interface ApplyAckDto {
  applied: boolean;
  seq: number;
}

export interface ProblemPadDto {
  id: string;
  dataset: string;
  task_id: string;
  updated_at: number;
  sync_seq?: number;
  base_updated_at?: number | null;
  board: unknown;
  agent: unknown;
}

/** One page of handwriting: `gz` is base64 of the bytes `STORE_INK_PAGES` holds. */
export interface InkPageDto {
  kind: "annotate" | "whiteboard";
  key: string;
  page_id: number;
  updated_at: number;
  gz: string;
}

/** The same row without its bytes — what the ping carries. */
export type InkPageDigestDto = Omit<InkPageDto, "gz">;

export interface EdgeRowDto {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  kind: string;
  created_at: number;
  payload: unknown;
  updated_at?: number;
}

export interface PadSyncPingDto {
  now: number;
  whiteboard: WhiteboardPadDto[];
  annotate: AnnotatePadDto[];
  problem?: ProblemPadDto[];
  snapshots: PadSnapshotDto[];
  gone?: PadGoneDto[];
  /**
   * Which pages of handwriting changed since `since` — stamps, never strokes.
   *
   * Absent from an older hub, which is why every reader treats it as optional:
   * a device that has not been updated simply reports no ink and syncs the rest
   * exactly as it did before.
   */
  ink?: InkPageDigestDto[];
  edges?: EdgeRowDto[];
  gone_edges?: string[];
}

export interface DevicePrefsDto {
  id: string;
  role: string;
  prefs: unknown;
  updated_at: number;
}

export interface DlcStatus {
  slug: string;
  label: string;
  installed: boolean;
  count: number;
  phase: string;
  progress: number;
  downloaded?: number;
  total?: number;
  error: string | null;
}

function errorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
  } catch {
    // Not JSON.
  }
  return body.trim() || `request failed with status ${status}`;
}

function bodyText(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

export class LcClient {
  async health(): Promise<{ ok: boolean; version: string; requires_token: boolean }> {
    return this.cmd("lc_health");
  }

  async searchProblems(options: SearchOptions = {}): Promise<ProblemPage> {
    return this.cmd("lc_list_problems", { args: options });
  }

  async tags(dataset?: string): Promise<string[]> {
    return this.cmd("lc_list_tags", { dataset });
  }

  async datasets(): Promise<DatasetInfo[]> {
    return this.cmd("lc_list_datasets");
  }

  async dlcStatus(): Promise<DlcStatus[]> {
    return this.cmd("lc_dataset_dlc_status");
  }

  async dlcInstall(slug: string): Promise<DlcStatus> {
    return this.cmd("lc_dataset_dlc_install", { slug });
  }

  async dlcRemove(slug: string): Promise<DlcStatus> {
    return this.cmd("lc_dataset_dlc_remove", { slug });
  }

  async randomProblem(options: SearchOptions = {}): Promise<ProblemSummary | null> {
    return this.cmd("lc_random_problem", { args: options });
  }

  async getSession(): Promise<SessionSnapshot> {
    return this.cmd("lc_get_session");
  }

  async resetSession(): Promise<SessionSnapshot> {
    return this.cmd("lc_reset_session");
  }

  async enqueueSession(taskId: string, dataset?: string): Promise<SessionSnapshot> {
    return this.cmd("lc_enqueue_session", { taskId, dataset });
  }

  async randomSession(
    options: {
      dataset?: string;
      count?: number;
      difficulty?: string;
      tag?: string;
      q?: string;
    } = {},
  ): Promise<SessionSnapshot> {
    return this.cmd("lc_random_session", { body: options });
  }

  async getConfig(): Promise<LcConfig> {
    return this.cmd("lc_get_config");
  }

  /** Why config fell back to defaults at startup, or null if it did not. */
  async bootNotice(): Promise<string | null> {
    try {
      return await this.cmd<string | null>("boot_notice");
    } catch {
      // An older shell has no such command. Nothing to report is the right
      // answer there, and it is not worth a banner of its own.
      return null;
    }
  }

  /** The address a tablet should type to reach this PC. Null on the tablet. */
  async lanBaseUrl(port: number): Promise<string | null> {
    try {
      return await this.cmd<string | null>("lan_base_url", { port });
    } catch {
      return null;
    }
  }

  async putConfig(config: LcConfigPut, opts?: { timeoutMs?: number }): Promise<LcConfig> {
    return this.cmd("lc_put_config", { config }, opts?.timeoutMs);
  }

  async llmStatus(): Promise<LlmStatus> {
    return this.cmd("lc_llm_status");
  }

  /**
   * What this provider could be pointed at: the server's own list, plus any
   * `.gguf` under the models folder. Read-only — it never sets the vision flag.
   */
  async listModels(provider?: string): Promise<ModelCatalog> {
    return this.cmd("lc_llm_models", { provider });
  }

  async llmStart(): Promise<LlmStatus> {
    return this.cmd("lc_llm_start");
  }

  async llmStop(): Promise<LlmStatus> {
    return this.cmd("lc_llm_stop");
  }

  async openWorkspace(
    id: string,
    target: "ide" | "canvas",
    dataset?: string,
  ): Promise<{
    task_id: string;
    target: string;
    workspace_dir: string;
  }> {
    return this.cmd("lc_open_workspace", { id, target, dataset });
  }

  async adjacentProblems(id: string, options: SearchOptions = {}): Promise<AdjacentProblems> {
    return this.cmd("lc_adjacent_problem", { id, args: options });
  }

  async getProblem(id: string, dataset?: string): Promise<ProblemDetail> {
    return this.cmd("lc_get_problem", { id, dataset });
  }

  async loadProblem(id: string, dataset?: string): Promise<LoadResponse> {
    return this.cmd("lc_load_problem", { id, dataset });
  }

  async workspaceMeta(id: string, dataset?: string): Promise<WorkspaceMeta> {
    return this.cmd("lc_workspace_meta", { id, dataset });
  }

  async runTests(id: string, dataset?: string): Promise<TestResponse> {
    return this.cmd("lc_run_tests", { id, dataset });
  }

  async getSolution(id: string, dataset?: string): Promise<{ task_id: string; source: string }> {
    return this.cmd("lc_get_solution", { id, dataset });
  }

  async putSolution(
    id: string,
    source: string,
    dataset?: string,
  ): Promise<{ task_id: string; source: string }> {
    return this.cmd("lc_put_solution", { id, source, dataset });
  }

  async getBoard(id: string, dataset?: string): Promise<{ task_id: string; board: unknown | null }> {
    return this.cmd("lc_get_board", { id, dataset });
  }

  async putBoard(
    id: string,
    board: unknown,
    dataset?: string,
  ): Promise<{ task_id: string; board: unknown | null }> {
    return this.cmd("lc_put_board", { id, board, dataset });
  }

  async getAgentSession(
    id: string,
    dataset?: string,
  ): Promise<{ task_id: string; dataset: string; messages: unknown[] }> {
    return this.cmd("lc_get_agent_session", { id, dataset });
  }

  async putAgentSession(
    id: string,
    messages: unknown[],
    dataset?: string,
  ): Promise<{ task_id: string; dataset: string; messages: unknown[] }> {
    return this.cmd("lc_put_agent_session", { id, messages, dataset });
  }

  async finishAttempt(
    id: string,
    options: { solved: boolean; save: boolean },
    dataset?: string,
  ): Promise<AttemptOutcome> {
    return this.cmd("lc_finish_attempt", {
      id,
      solved: options.solved,
      save: options.save,
      dataset,
    });
  }

  async capabilities(): Promise<CoachCapabilities> {
    return this.cmd("lc_coach_capabilities");
  }

  async review(
    taskId: string,
    board: BoardSnapshot,
    dataset?: string,
    opts?: { layoutOnly?: boolean; timeoutMs?: number },
  ): Promise<ReviewResponse> {
    return this.cmd(
      "lc_coach_review",
      {
        body: {
          task_id: taskId,
          dataset,
          layout_only: opts?.layoutOnly === true,
          ...board,
        },
      },
      opts?.timeoutMs ?? COACH_HTTP_TIMEOUT_MS,
    );
  }

  async scaffoldBoard(taskId: string, dataset?: string): Promise<BoardScaffold> {
    return this.cmd("lc_coach_scaffold", { body: { task_id: taskId, dataset } });
  }

  async viz(
    taskId: string,
    board: BoardSnapshot,
    ask = "",
    dataset?: string,
  ): Promise<VizEnvelope> {
    return this.cmd("lc_coach_viz", { body: { task_id: taskId, dataset, board, ask } });
  }

  async drawReview(
    taskId: string,
    program: unknown,
    png: string,
    ask = "",
    dataset?: string,
  ): Promise<import("./types").DrawReviewEnvelope> {
    return this.cmd("lc_coach_draw_review", {
      body: { task_id: taskId, dataset, program, png, ask },
    });
  }

  async reveal(
    taskId: string,
    board: BoardSnapshot,
    confirmReveal: boolean,
    dataset?: string,
    mode: "bridge" | "lazy" = "bridge",
  ): Promise<BridgeResponse> {
    return this.cmd("lc_coach_reveal", {
      body: {
        task_id: taskId,
        dataset,
        confirm_reveal: confirmReveal,
        mode,
        board,
      },
    });
  }

  async lazyFill(
    taskId: string,
    board: BoardSnapshot,
    dataset?: string,
  ): Promise<import("./types").LazyFillResponse> {
    try {
      return await this.cmd("lc_coach_lazy", { body: { task_id: taskId, dataset, board } });
    } catch (cause) {
      if (cause instanceof LcApiError && cause.status === 404) {
        throw new LcApiError("Lazy fill needs lc_coach_lazy — rebuild and restart the app", 404);
      }
      throw cause;
    }
  }

  async ask(
    question: string,
    opts: {
      surface: "whiteboard" | "annotate" | "problem";
      task_id?: string;
      dataset?: string;
      images?: string[];
      timeoutMs?: number;
      document_hash?: string;
      page?: number;
      highlight?: string;
      page_text?: string;
      marks_prose?: string;
      preset?: string;
      reasoning?: boolean;
      reasoning_effort?: "low" | "medium" | "high";
    },
  ): Promise<{
    task_id: string;
    provider: string;
    reply: string;
    reasoning?: string;
    proposed_annotations?: ProposedAnnotation[];
    process_events?: Array<{
      kind: string;
      label: string;
      detail?: string;
      status?: string;
      ts: number;
    }>;
  }> {
    const { surface, task_id, dataset, images, timeoutMs } = opts;
    const body: Record<string, unknown> = {
      surface,
      question,
      ...(task_id ? { task_id } : {}),
      ...(images && images.length > 0 ? { images } : {}),
    };
    if (surface === "problem") body.dataset = dataset;
    if (opts.document_hash) body.document_hash = opts.document_hash;
    if (opts.page != null) body.page = opts.page;
    if (opts.highlight) body.highlight = opts.highlight;
    if (opts.page_text) body.page_text = opts.page_text;
    if (opts.marks_prose) body.marks_prose = opts.marks_prose;
    if (opts.preset) body.preset = opts.preset;
    if (opts.reasoning) body.reasoning = true;
    if (opts.reasoning_effort) body.reasoning_effort = opts.reasoning_effort;
    try {
      return await this.cmd("lc_coach_ask", { body }, timeoutMs ?? COACH_HTTP_TIMEOUT_MS);
    } catch (cause) {
      if (cause instanceof LcApiError && cause.status === 404) {
        throw new LcApiError("Ask needs lc_coach_ask — rebuild and restart the app", 404);
      }
      throw cause;
    }
  }

  async getDocIndex(hash: string): Promise<DocIndexStatus> {
    // With a hub, "is this indexed" is a hub question: the tablet no longer
    // fills its own index, so its local db would answer about the past.
    const hub = loadPadHub();
    if (hub) {
      return hubJson<DocIndexStatus>(hub, "GET", `/docs/${encodeURIComponent(hash)}/index`);
    }
    return this.cmd("lc_docs_get_index", { hash });
  }

  /**
   * Wipe this device's whole search index (`docs.db`).
   *
   * Deliberately not hub-routed, unlike every other docs call here: the
   * leftover index a reader clears is the *local* one, and "clear" reaching
   * past this machine would be a surprise no button label can carry.
   */
  async clearLocalDocIndex(): Promise<{ documents: number; chunks: number }> {
    return this.cmd<{ documents: number; chunks: number }>(
      "lc_docs_clear_local_index",
      {},
      60_000,
    );
  }

    /**
   * Run one budget of the embedding pass.
   *
   * Deliberately not a call that runs to completion: a book is minutes of work,
   * and returning between budgets is what lets the reader close the app in the
   * middle of one. Call until `done === total`, and stop on a `reason`.
   */
  async embedDoc(hash: string): Promise<DocEmbedProgress> {
    // Same reasoning as getDocIndex: embedding budgets run on whichever side
    // owns docs.db.
    const hub = loadPadHub();
    if (hub) {
      return hubJson<DocEmbedProgress>(hub, "POST", `/docs/${encodeURIComponent(hash)}/embed`);
    }
    return this.cmd("lc_docs_embed", { hash });
  }

  /**
   * Ask the hub to index a document from the bytes it already holds.
   *
   * Hub-only by design — locally there is nothing this could do that
   * `putDocIndex` does not. Markdown and code carry their source text in the
   * body; PDF is extracted hub-side from the stored blob. A 204 answer means
   * "already indexed, unchanged", which reads as indexed.
   */
  async indexFromBytes(
    hash: string,
    body: { name: string; doc_type: string; source_text?: string },
  ): Promise<{ indexed: boolean }> {
    /*
     * Hub-only, and said so rather than asserted.
     *
     * This used to be `loadPadHub()!`. There is no local route for it — the
     * whole point is that the hub extracts from its own copy of the bytes —
     * but force-unwrapping turned "no hub is configured" into a null
     * dereference inside the fetch, which reached the reader as a stack shape
     * rather than the one sentence that would have explained it.
     */
    const hub = loadPadHub();
    if (!hub) {
      throw new Error("no hub is set — add one in Settings before indexing there");
    }
    const result = await hubJson<
      { status?: { indexed?: boolean } } | null
    >(hub, "POST", `/docs/${encodeURIComponent(hash)}/index-from-bytes`, body);
    if (!result) return { indexed: true };
    return { indexed: result.status?.indexed === true };
  }

  /**
   * `force` rewrites a document whose page count has not changed.
   *
   * Indexing is idempotent on page count, which is right for reopening the same
   * file and wrong for the one case that matters here: turning an embedding
   * model on moves no page counts, so the vectors that most need redoing are
   * exactly the ones the guard skips.
   */
  async putDocIndex(
    hash: string,
    body: {
      name: string;
      doc_type: string;
      pages: Array<{ page: number; text: string; heading?: string }>;
    },
    opts?: { force?: boolean },
  ): Promise<{ indexed: boolean; wrote: boolean }> {
    // With a hub, extracted pages belong in the hub's docs.db — the tablet
    // only produces them (this path now serves the one doc kind the hub
    // cannot read from bytes: epub, whose parsing is plain zip + HTML).
    const hub = loadPadHub();
    if (hub) {
      const forceQuery = opts?.force ? "?force=true" : "";
      await hubJson<unknown>(
        hub,
        "PUT",
        `/docs/${encodeURIComponent(hash)}/index${forceQuery}`,
        body,
      );
      return { indexed: true, wrote: true };
    }
    const result = await this.cmd<{
      hash?: string;
      indexed?: boolean;
      wrote?: boolean;
    } | null>("lc_docs_put_index", { hash, body, force: opts?.force ?? false }, 180_000);
    if (!result) return { indexed: false, wrote: false };
    return { indexed: result.indexed === true, wrote: Boolean(result.wrote) };
  }

  /**
   * The chunks of one document nearest a query.
   *
   * The scoring has always existed — the coach uses it for document Ask — but
   * the client had no way in, so link suggestions had nothing to suggest from.
   * Returns `[]` rather than throwing when the document was never indexed or
   * the harness is unreachable: suggestions are a convenience, and a link tool
   * that errors because a hint is unavailable is worse than one that offers no
   * hints.
   */
  async retrieveDoc(
    hash: string,
    query: string,
    k = 4,
  ): Promise<Array<{ page: number; heading?: string; text: string; score: number }>> {
    try {
      // Ask owns the hub's docs.db when one is set — same split as getDocIndex.
      const hub = loadPadHub();
      const chunks = hub
        ? (
            await hubJson<{ chunks?: Array<{ page?: number; heading?: string | null; text?: string; score?: number }> }>(
              hub,
              "POST",
              `/docs/${encodeURIComponent(hash)}/retrieve?q=${encodeURIComponent(query)}&k=${k}`,
            )
          ).chunks ?? []
        : (
            (await this.cmd<{
              chunks?: Array<{
                page?: number;
                heading?: string | null;
                text?: string;
                score?: number;
              }>;
            } | null>("lc_docs_retrieve", { hash, query, k }))?.chunks ?? []
          );
      return chunks.flatMap((chunk) =>
        typeof chunk?.text === "string" && chunk.text.trim()
          ? [
              {
                page: typeof chunk.page === "number" ? chunk.page : 0,
                heading: chunk.heading ?? undefined,
                text: chunk.text,
                score: typeof chunk.score === "number" ? chunk.score : 0,
              },
            ]
          : [],
      );
    } catch {
      return [];
    }
  }

  async listDocChunkDigests(): Promise<DocChunkDigest[]> {
    const hub = loadPadHub();
    if (hub) {
      const { json } = await hubFetch(hub, "GET", "/docs/chunk-digests");
      return parseChunkDigests(json);
    }
    return this.listDocChunkDigestsLocal();
  }

  async listDocChunkDigestsLocal(): Promise<DocChunkDigest[]> {
    const body = await this.cmd<unknown>("lc_docs_list_chunk_digests", {});
    return parseChunkDigests(body);
  }

  /** Ask every indexed document. Explore's home; the agent has its own tool. */
  async retrieveLibrary(query: string, k = 6): Promise<LibraryAnswer> {
    const hub = loadPadHub();
    const body = { query, k };
    const raw = hub
      ? (await hubFetch(hub, "POST", "/docs/retrieve", { json: body })).json
      : await this.cmd<unknown>("lc_docs_retrieve_library", { body });
    const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const scopeRaw =
      row.scope && typeof row.scope === "object"
        ? (row.scope as Record<string, unknown>)
        : {};
    return {
      chunks: Array.isArray(row.chunks) ? (row.chunks as LibraryHit[]) : [],
      scope: {
        searched: typeof scopeRaw.searched === "number" ? scopeRaw.searched : 0,
        total: typeof scopeRaw.total === "number" ? scopeRaw.total : 0,
        skipped: Array.isArray(scopeRaw.skipped) ? (scopeRaw.skipped as string[]) : [],
        lexical: scopeRaw.lexical === true,
      },
      summary: typeof row.summary === "string" ? row.summary : "",
    };
  }

  async getDocChunks(hash: string): Promise<DocChunkBundle> {
    const hub = loadPadHub();
    if (hub) {
      const { json } = await hubFetch(
        hub,
        "GET",
        `/docs/${encodeURIComponent(hash)}/chunks`,
      );
      return parseChunkBundle(hash, json);
    }
    return this.getDocChunksLocal(hash);
  }

  async getDocChunksLocal(hash: string): Promise<DocChunkBundle> {
    const body = await this.cmd<unknown>("lc_docs_get_chunks", { hash });
    return parseChunkBundle(hash, body);
  }

  async putDocChunks(hash: string, body: DocChunkBundle): Promise<DocChunkMergeAck> {
    const hub = loadPadHub();
    if (hub) {
      const { json } = await hubFetch(
        hub,
        "PUT",
        `/docs/${encodeURIComponent(hash)}/chunks`,
        { json: body },
      );
      return parseChunkMergeAck(json);
    }
    return this.mergeDocChunksLocal(body);
  }

  async mergeDocChunksLocal(body: DocChunkBundle): Promise<DocChunkMergeAck> {
    const ack = await this.cmd<unknown>("lc_docs_put_chunks", { hash: body.hash, body });
    return parseChunkMergeAck(ack);
  }

  async putDocBytes(hash: string, bytes: ArrayBuffer): Promise<void> {
    const hub = loadPadHub();
    if (hub) {
      await hubFetch(hub, "PUT", `/docs/${encodeURIComponent(hash)}/bytes`, { bytes });
      return;
    }
    await this.cmd("lc_docs_put_bytes", {
      hash,
      rawBase64: bytesToB64(new Uint8Array(bytes)),
    });
  }

  async getDocBytes(hash: string): Promise<ArrayBuffer | null> {
    const hub = loadPadHub();
    if (hub) {
      try {
        const { json, bytes } = await hubFetch(
          hub,
          "GET",
          `/docs/${encodeURIComponent(hash)}/bytes`,
        );
        /*
         * A 200 is not proof this is the document.
         *
         * `hubFetch` hands back the response body whatever it turned out to
         * be, and a hub — or anything between here and it — can answer a
         * missing document with a JSON envelope or an HTML page and still call
         * it success. Returned as-is, that text becomes the PDF: the caller
         * caches it under the content hash and every later open reads a few
         * hundred bytes of markup back. `json` is only set when the response
         * announced itself as JSON, which a document never does.
         */
        if (json != null) return null;
        return bytes;
      } catch (cause) {
        if (cause instanceof LcApiError && cause.status === 404) return null;
        throw cause;
      }
    }
    try {
      const body = await this.cmd<unknown>("lc_docs_get_bytes", { hash });
      if (body && typeof body === "object" && "$bytes" in body) {
        const packed = body as { $bytes: string };
        const copy = b64ToBytes(packed.$bytes).slice();
        return copy.buffer as ArrayBuffer;
      }
      return null;
    } catch (cause) {
      if (cause instanceof LcApiError && cause.status === 404) return null;
      throw cause;
    }
  }

  async pingPadSync(since: number): Promise<PadSyncPingDto> {
    const body = await padInvokeOrHub<PadSyncPingDto>(
      () => this.cmd("lc_pads_sync", { since }),
      "GET",
      `/pads/sync?since=${Math.max(0, Math.floor(since))}`,
    );
    return {
      now: typeof body?.now === "number" ? body.now : Date.now(),
      whiteboard: Array.isArray(body?.whiteboard) ? body.whiteboard : [],
      annotate: Array.isArray(body?.annotate) ? body.annotate : [],
      problem: Array.isArray(body?.problem) ? body.problem : [],
      snapshots: Array.isArray(body?.snapshots) ? body.snapshots : [],
      gone: Array.isArray(body?.gone) ? body.gone : [],
      ink: Array.isArray(body?.ink) ? body.ink : [],
      edges: Array.isArray(body?.edges) ? body.edges : [],
      gone_edges: Array.isArray(body?.gone_edges) ? body.gone_edges : [],
    };
  }

  async getInkPages(kind: "annotate" | "whiteboard", key: string): Promise<InkPageDto[]> {
    const rows = await padInvokeOrHub<InkPageDto[]>(
      () => this.cmd("lc_get_ink_pages", { kind, key }),
      "GET",
      `/pads/ink/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,
    );
    return Array.isArray(rows) ? rows : [];
  }

  /** One page per call, so a refused page never holds up the rest of a pad. */
  async putInkPage(body: InkPageDto): Promise<ApplyAckDto> {
    const ack = await padInvokeOrHub<ApplyAckDto>(
      () => this.cmd("lc_put_ink_page", { body }),
      "PUT",
      "/pads/ink",
      body,
    );
    return {
      applied: ack?.applied !== false,
      seq: typeof ack?.seq === "number" ? ack.seq : 0,
    };
  }

  async putEdges(body: EdgeRowDto[]): Promise<void> {
    if (body.length === 0) return;
    await padInvokeOrHub<void>(
      () => this.cmd("lc_put_edges", { body }),
      "PUT",
      "/pads/edges",
      body,
    );
  }

  async tombstoneEdge(id: string): Promise<void> {
    await padInvokeOrHub<void>(
      () => this.cmd("lc_tombstone_edge", { id }),
      "POST",
      `/pads/edges/${encodeURIComponent(id)}/tombstone`,
    );
  }

  async listWhiteboardPads(): Promise<WhiteboardPadDto[]> {
    return padInvokeOrHub(
      () => this.cmd("lc_list_whiteboard"),
      "GET",
      "/pads/whiteboard",
    );
  }

  /**
   * One pad, by id — `null` when the hub has no live row for it.
   *
   * The listings answer the same question, and callers were using them to:
   * finding one row meant pulling every board with its elements, files and ink
   * palettes, or every annotated document with its footnotes, and throwing all
   * but one away.
   *
   * Without a hub there is nothing to save — the local list is an in-process
   * call — so that path still filters the listing.
   */
  async getWhiteboardPad(id: string): Promise<WhiteboardPadDto | null> {
    const hub = loadPadHub();
    if (!hub) {
      const rows = await this.listWhiteboardPads();
      return rows.find((row) => row.id === id) ?? null;
    }
    try {
      const { json } = await hubFetch(hub, "GET", `/pads/whiteboard/${encodeURIComponent(id)}`);
      return (json as WhiteboardPadDto | null) ?? null;
    } catch (cause) {
      // Absent is an answer, not a failure. Anything else is the hub's.
      if (cause instanceof LcApiError && cause.status === 404) return null;
      throw cause;
    }
  }

  /** One annotate pad, by id. See {@link getWhiteboardPad}. */
  async getAnnotatePad(id: string): Promise<AnnotatePadDto | null> {
    const hub = loadPadHub();
    if (!hub) {
      const rows = await this.listAnnotatePads();
      return rows.find((row) => row.id === id) ?? null;
    }
    try {
      const { json } = await hubFetch(hub, "GET", `/pads/annotate/${encodeURIComponent(id)}`);
      return (json as AnnotatePadDto | null) ?? null;
    } catch (cause) {
      if (cause instanceof LcApiError && cause.status === 404) return null;
      throw cause;
    }
  }

  async listWhiteboardArchive(): Promise<WhiteboardPadDto[]> {
    return padInvokeOrHub(
      () => this.cmd("lc_archive_whiteboard"),
      "GET",
      "/pads/whiteboard/archive",
    );
  }

  async putWhiteboardPad(id: string, body: WhiteboardPadDto): Promise<WhiteboardPadDto> {
    return padInvokeOrHub(
      () => this.cmd("lc_put_whiteboard", { id, body }),
      "PUT",
      `/pads/whiteboard/${encodeURIComponent(id)}`,
      body,
    );
  }

  async tombstoneWhiteboardPad(id: string, seq = 0): Promise<ApplyAckDto> {
    return padInvokeOrHub(
      () => this.cmd("lc_tombstone_whiteboard", { id, seq }),
      "POST",
      `/pads/whiteboard/${encodeURIComponent(id)}/tombstone`,
      { seq },
    );
  }

  async restoreWhiteboardPad(id: string): Promise<void> {
    await padInvokeOrHub(
      () => this.cmd("lc_restore_whiteboard", { id }),
      "POST",
      `/pads/whiteboard/${encodeURIComponent(id)}/restore`,
    );
  }

  async listAnnotatePads(): Promise<AnnotatePadDto[]> {
    return padInvokeOrHub(
      () => this.cmd("lc_list_annotate"),
      "GET",
      "/pads/annotate",
    );
  }

  async listAnnotateArchive(): Promise<AnnotatePadDto[]> {
    return padInvokeOrHub(
      () => this.cmd("lc_archive_annotate"),
      "GET",
      "/pads/annotate/archive",
    );
  }

  async putAnnotatePad(id: string, body: AnnotatePadDto): Promise<AnnotatePadDto> {
    return padInvokeOrHub(
      () => this.cmd("lc_put_annotate", { id, body }),
      "PUT",
      `/pads/annotate/${encodeURIComponent(id)}`,
      body,
    );
  }

  async tombstoneAnnotatePad(id: string, seq = 0): Promise<ApplyAckDto> {
    return padInvokeOrHub(
      () => this.cmd("lc_tombstone_annotate", { id, seq }),
      "POST",
      `/pads/annotate/${encodeURIComponent(id)}/tombstone`,
      { seq },
    );
  }

  async restoreAnnotatePad(id: string): Promise<void> {
    await padInvokeOrHub(
      () => this.cmd("lc_restore_annotate", { id }),
      "POST",
      `/pads/annotate/${encodeURIComponent(id)}/restore`,
    );
  }

  async getProblemPad(dataset: string, taskId: string): Promise<ProblemPadDto | null> {
    try {
      return await padInvokeOrHub(
        () => this.cmd("lc_get_problem_pad", { dataset, task_id: taskId }),
        "GET",
        `/pads/problem/${encodeURIComponent(dataset)}/${encodeURIComponent(taskId)}`,
      );
    } catch (cause) {
      if (cause instanceof LcApiError && cause.status === 404) return null;
      throw cause;
    }
  }

  async putProblemPad(dataset: string, taskId: string, body: ProblemPadDto): Promise<ProblemPadDto> {
    return padInvokeOrHub(
      () => this.cmd("lc_put_problem", { dataset, task_id: taskId, body }),
      "PUT",
      `/pads/problem/${encodeURIComponent(dataset)}/${encodeURIComponent(taskId)}`,
      body,
    );
  }

  async tombstoneProblemPad(dataset: string, taskId: string, seq = 0): Promise<ApplyAckDto> {
    return padInvokeOrHub(
      () => this.cmd("lc_tombstone_problem", { dataset, task_id: taskId, seq }),
      "POST",
      `/pads/problem/${encodeURIComponent(dataset)}/${encodeURIComponent(taskId)}/tombstone`,
      { seq },
    );
  }

  async putPadSnapshot(body: PadSnapshotDto): Promise<void> {
    await padInvokeOrHub(
      () => this.cmd("lc_put_snapshot", { body }),
      "PUT",
      "/pads/snapshots",
      body,
    );
  }

  async getPadSnapshots(kind: string, key: string): Promise<PadSnapshotDto[]> {
    return padInvokeOrHub(
      () => this.cmd("lc_get_snapshots", { kind, key }),
      "GET",
      `/pads/snapshots/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,
    );
  }

  async listDevices(): Promise<DevicePrefsDto[]> {
    return this.cmd("lc_list_devices");
  }

  async getDevicePrefs(id: string): Promise<DevicePrefsDto | null> {
    try {
      return await this.cmd("lc_get_device_prefs", { id });
    } catch (cause) {
      if (cause instanceof LcApiError && cause.status === 404) return null;
      throw cause;
    }
  }

  async putDevicePrefs(id: string, body: DevicePrefsDto): Promise<DevicePrefsDto> {
    return this.cmd("lc_put_device_prefs", { id, body });
  }

  async cloneDevicePrefs(id: string, role: string): Promise<DevicePrefsDto | null> {
    return this.cmd("lc_clone_device_prefs", { id, role });
  }

  private async cmd<T>(
    command: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const invoke = await loadInvoke();
    if (!invoke) {
      const message = "this build has no in-process harness — use the Tauri app";
      announceUnreachable(message);
      throw new LcApiError(message, 0);
    }

    const run = invoke<unknown>(command, args ?? {});
    let raw: unknown;
    try {
      raw =
        timeoutMs != null && timeoutMs > 0
          ? await Promise.race([
              run,
              new Promise<never>((_, reject) => {
                window.setTimeout(() => {
                  reject(
                    new LcApiError(
                      `the harness did not answer ${command} within ${Math.round(timeoutMs / 1000)}s`,
                      0,
                    ),
                  );
                }, timeoutMs);
              }),
            ])
          : await run;
    } catch (cause) {
      if (cause instanceof LcApiError) throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      announceUnreachable(message);
      throw new LcApiError(message, 0);
    }

    const result = readInvokeResult<T>(raw);
    if (result.status >= 400) {
      const text = bodyText(result.body);
      throw new LcApiError(errorMessage(text, result.status), result.status, text, result.body);
    }
    return result.body;
  }
}
