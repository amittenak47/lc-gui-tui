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
import type { BoardSnapshot, ServerFrame } from "./types";

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
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAnalyzedHash: number | null = null;
  /** Guards against a slow capture overlapping the next tick. */
  private capturing = false;
  private readonly sessionId: string;

  constructor(
    private readonly pairing: Pairing,
    private readonly handlers: AmbientHandlers,
    private readonly createSocket: SocketFactory = (url) =>
      new WebSocket(url) as unknown as WebSocketLike,
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? `s-${Math.random().toString(36).slice(2, 10)}`;
  }

  start(
    taskId: string,
    probe: Probe,
    capture: Capture,
    intervalMs = AMBIENT_INTERVAL_MS,
  ): void {
    this.stop();
    const socket = this.createSocket(coachSocketUrl(this.pairing));
    this.socket = socket;

    socket.onopen = () => {
      this.send({ type: "hello", session_id: this.sessionId, task_id: taskId });
      this.handlers.onOpen?.();
    };
    socket.onmessage = (event) => {
      try {
        this.handlers.onFrame(JSON.parse(event.data) as ServerFrame);
      } catch {
        this.handlers.onError?.("unreadable frame from the coach");
      }
    };
    socket.onerror = () => this.handlers.onError?.("the coach connection failed");
    socket.onclose = () => this.handlers.onClose?.();

    this.timer = setInterval(() => void this.tick(taskId, probe, capture), intervalMs);
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
    this.socket?.close();
    this.socket = null;
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
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch {
      this.handlers.onError?.("could not reach the coach");
    }
  }
}
