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

export interface PadSyncPingDto {
  now: number;
  whiteboard: WhiteboardPadDto[];
  annotate: AnnotatePadDto[];
  problem?: ProblemPadDto[];
  snapshots: PadSnapshotDto[];
  gone?: PadGoneDto[];
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

  async putConfig(config: LcConfigPut, opts?: { timeoutMs?: number }): Promise<LcConfig> {
    return this.cmd("lc_put_config", { config }, opts?.timeoutMs);
  }

  async llmStatus(): Promise<LlmStatus> {
    return this.cmd("lc_llm_status");
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
    return this.cmd("lc_docs_get_index", { hash });
  }

  async putDocIndex(
    hash: string,
    body: {
      name: string;
      doc_type: string;
      pages: Array<{ page: number; text: string; heading?: string }>;
    },
  ): Promise<{ indexed: boolean; wrote: boolean }> {
    const result = await this.cmd<{
      hash?: string;
      indexed?: boolean;
      wrote?: boolean;
    } | null>("lc_docs_put_index", { hash, body }, 180_000);
    if (!result) return { indexed: true, wrote: false };
    return { indexed: result.indexed !== false, wrote: Boolean(result.wrote) };
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
      const body = await this.cmd<{
        chunks?: Array<{ page?: number; heading?: string | null; text?: string; score?: number }>;
      } | null>("lc_docs_retrieve", { hash, query, k });
      return (body?.chunks ?? []).flatMap((chunk) =>
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
        const { bytes } = await hubFetch(hub, "GET", `/docs/${encodeURIComponent(hash)}/bytes`);
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
    };
  }

  async listWhiteboardPads(): Promise<WhiteboardPadDto[]> {
    return padInvokeOrHub(
      () => this.cmd("lc_list_whiteboard"),
      "GET",
      "/pads/whiteboard",
    );
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
