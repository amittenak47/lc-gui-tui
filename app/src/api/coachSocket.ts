/**
 * The ambient coach's client half.
 *
 * The cadence lives here rather than on the daemon, because the cheap
 * decision — *has anything changed?* — needs the scene, and the scene is here.
 * An untouched board therefore costs nothing at all: no socket traffic, no
 * tokens, and no ink recognition. Default is 120s so a slow local model can
 * finish a nudge before the next tick (overlapping ticks are also gated).
 *
 * Sampling is deliberately two-stage:
 *
 * 1. {@link Probe} — synchronous and cheap. Hashes the scene and counts new
 *    elements.
 * 2. {@link Capture} — asynchronous and expensive. Runs handwriting recognition
 *    and builds the snapshot, and only runs once stage 1 has said it's worth it.
 */

import { coachSocketUrl, type Pairing } from "./pairing";
import type { BoardSnapshot, CoachProcessEvent, RunAction, ServerFrame } from "./types";

/** Between ambient ticks. Long enough for a local model to answer. */
export const AMBIENT_INTERVAL_MS = 120_000;
/**
 * Below this many new elements, wait. One stray dot is not a new idea, and
 * nudging on it makes the coach feel twitchy.
 */
export const MIN_NEW_ELEMENTS = 3;

/** Stage 1: what can be known about the board without doing any work. */
export interface AmbientProbe {
  sceneHash: number;
  /** Elements added since the last analysed board. */
  newElements: number;
  /** Whether there is anything on the board at all. */
  hasContent: boolean;
}

/** Stage 2: recognition and snapshot building. */
export type Probe = () => AmbientProbe;
export type Capture = () => Promise<BoardSnapshot>;

export type SkipReason = "unchanged" | "too-little-new" | "empty";

export interface AnalyzeDecision {
  analyze: boolean;
  reason?: SkipReason;
}

/**
 * Whether a tick is worth the round trip. Pure, so the cost-control rule is
 * testable without a socket or a canvas.
 */
export function shouldAnalyze(
  probe: AmbientProbe,
  lastAnalyzedHash: number | null,
  minNewElements = MIN_NEW_ELEMENTS,
): AnalyzeDecision {
  if (!probe.hasContent) {
    return { analyze: false, reason: "empty" };
  }
  if (lastAnalyzedHash !== null && probe.sceneHash === lastAnalyzedHash) {
    return { analyze: false, reason: "unchanged" };
  }
  // The first look is always allowed through; after that, require real work.
  if (lastAnalyzedHash !== null && probe.newElements < minNewElements) {
    return { analyze: false, reason: "too-little-new" };
  }
  return { analyze: true };
}

/** Live progress for one interactive run, as its stages land. */
export interface RunHandlers {
  onProcess?(event: CoachProcessEvent): void;
}

/** A run the client asked for and is still waiting on. */
interface PendingRun {
  action: RunAction;
  handlers: RunHandlers;
  resolve(body: unknown): void;
  reject(error: Error): void;
}

export interface AmbientHandlers {
  onFrame(frame: ServerFrame): void;
  onSkip?(reason: SkipReason): void;
  /** Fired when stage 2 starts, so the panel can show it without blocking. */
  onCapturing?(): void;
  onOpen?(): void;
  onClose?(): void;
  onError?(message: string): void;
}

/** Injected so tests can drive a fake socket. */
export type SocketFactory = (url: string) => WebSocketLike;

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

export class AmbientCoach {
  private socket: WebSocketLike | null = null;
  private open = false;
  /** Frames written before the socket opened, replayed in order on open. */
  private outbox: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAnalyzedHash: number | null = null;
  /** Guards against a slow capture overlapping the next tick. */
  private capturing = false;
  private readonly sessionId: string;
  /** Interactive runs awaiting a `result` or `error`, keyed by request id. */
  private readonly pending = new Map<string, PendingRun>();
  private runSeq = 0;

  constructor(
    private readonly pairing: Pairing,
    private readonly handlers: AmbientHandlers,
    private readonly createSocket: SocketFactory = (url) =>
      new WebSocket(url) as unknown as WebSocketLike,
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? `s-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Open the socket for this problem without starting the ambient timer.
   *
   * Interactive runs and ambient nudges share one connection: they are the
   * same authenticated endpoint, and keeping them on one socket is what lets
   * the client tell them apart by `request_id` rather than by which of two
   * connections a frame arrived on.
   */
  connect(taskId: string): void {
    this.stop();
    const socket = this.createSocket(coachSocketUrl(this.pairing));
    this.socket = socket;

    socket.onopen = () => {
      this.open = true;
      this.send({ type: "hello", session_id: this.sessionId, task_id: taskId });
      const queued = this.outbox;
      this.outbox = [];
      for (const frame of queued) this.write(frame);
      this.handlers.onOpen?.();
    };
    socket.onmessage = (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data) as ServerFrame;
      } catch {
        this.handlers.onError?.("unreadable frame from the coach");
        return;
      }
      // A frame that names a request belongs to that chat turn and to nothing
      // else — an ambient nudge must never land on a review's placeholder.
      if (this.routeRunFrame(frame)) return;
      this.handlers.onFrame(frame);
    };
    socket.onerror = () => this.handlers.onError?.("the coach connection failed");
    socket.onclose = () => {
      this.open = false;
      this.failPending("the coach connection closed before it answered");
      this.handlers.onClose?.();
    };
  }

  start(
    taskId: string,
    probe: Probe,
    capture: Capture,
    intervalMs = AMBIENT_INTERVAL_MS,
  ): void {
    this.connect(taskId);
    this.timer = setInterval(() => void this.tick(taskId, probe, capture), intervalMs);
  }

  /**
   * Run one interactive coach job and resolve with the same envelope the
   * matching `POST /coach/*` route would have returned.
   *
   * `payload` is that route's request body verbatim, so a caller that already
   * builds one for the HTTP client needs no second shape.
   */
  run<T>(
    action: RunAction,
    payload: Record<string, unknown>,
    handlers: RunHandlers = {},
  ): Promise<T> {
    const requestId = `run-${Date.now().toString(36)}-${(this.runSeq += 1)}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        action,
        handlers,
        resolve: (body) => resolve(body as T),
        reject,
      });
      this.send({ type: "run", request_id: requestId, action, payload });
    });
  }

  /** Ask the daemon to stop a run. Its promise rejects when the daemon agrees. */
  cancel(requestId: string): void {
    if (!this.pending.has(requestId)) return;
    this.send({ type: "cancel", request_id: requestId });
  }

  /** Whether a run is waiting — the daemon allows one per socket. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Interactive frames, dispatched to the run that asked for them. Returns
   * whether the frame was one — anything else falls through to the ambient
   * handler untouched.
   */
  private routeRunFrame(frame: ServerFrame): boolean {
    switch (frame.type) {
      case "stage": {
        this.pending.get(frame.request_id)?.handlers.onProcess?.({
          kind: "stage",
          label: frame.stage,
          detail: frame.detail || undefined,
          ts: Date.now(),
        });
        return true;
      }
      case "tool_event": {
        this.pending.get(frame.request_id)?.handlers.onProcess?.({
          kind: "tool",
          label: frame.name,
          detail: frame.reason || frame.summary || undefined,
          status: frame.status,
          ts: Date.now(),
        });
        return true;
      }
      case "result": {
        const run = this.pending.get(frame.request_id);
        if (!run) return true;
        this.pending.delete(frame.request_id);
        run.resolve(frame.body);
        return true;
      }
      case "error": {
        if (!frame.request_id) return false;
        const run = this.pending.get(frame.request_id);
        if (!run) return true;
        this.pending.delete(frame.request_id);
        run.reject(new Error(frame.message));
        return true;
      }
      default:
        return false;
    }
  }

  private failPending(reason: string): void {
    const waiting = Array.from(this.pending.values());
    this.pending.clear();
    for (const run of waiting) run.reject(new Error(reason));
  }

  /** Look now, skipping the change check — the panel's "look now" button. */
  async analyzeNow(taskId: string, capture: Capture, sceneHash: number): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    this.handlers.onCapturing?.();
    try {
      const board = await capture();
      this.lastAnalyzedHash = sceneHash;
      this.send({
        type: "snapshot",
        session_id: this.sessionId,
        task_id: taskId,
        scene_hash: sceneHash,
        ...board,
      });
    } catch (cause) {
      this.handlers.onError?.(cause instanceof Error ? cause.message : String(cause));
    } finally {
      this.capturing = false;
    }
  }

  /** Clear the escalation ladder — e.g. after the student wipes the board. */
  reset(): void {
    this.lastAnalyzedHash = null;
    this.send({ type: "reset", session_id: this.sessionId });
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Tell the daemon before dropping the connection, so a run mid-stage is
    // cancelled rather than left to finish into a socket nobody reads.
    for (const requestId of this.pending.keys()) {
      this.send({ type: "cancel", request_id: requestId });
    }
    this.failPending("the coach was stopped before it answered");
    this.socket?.close();
    this.socket = null;
    this.open = false;
    this.outbox = [];
    this.capturing = false;
  }

  private async tick(taskId: string, probe: Probe, capture: Capture): Promise<void> {
    if (this.capturing) return;
    const sampled = probe();
    const decision = shouldAnalyze(sampled, this.lastAnalyzedHash);
    if (!decision.analyze) {
      this.handlers.onSkip?.(decision.reason!);
      return;
    }
    await this.analyzeNow(taskId, capture, sampled.sceneHash);
  }

  private send(payload: unknown): void {
    const frame = JSON.stringify(payload);
    // A run can be requested in the same tick the panel mounts, before the
    // handshake finishes. Queue rather than drop: the alternative is a chat
    // turn that silently never answers.
    if (!this.open) {
      this.outbox.push(frame);
      return;
    }
    this.write(frame);
  }

  private write(frame: string): void {
    try {
      this.socket?.send(frame);
    } catch {
      this.handlers.onError?.("could not reach the coach");
    }
  }
}
