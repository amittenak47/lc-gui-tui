import { describe, expect, it, vi } from "vitest";

import {
  AmbientCoach,
  MIN_NEW_ELEMENTS,
  shouldAnalyze,
  type AmbientProbe,
  type WebSocketLike,
} from "./coachSocket";
import type { ServerFrame } from "./types";

function probe(overrides: Partial<AmbientProbe> = {}): AmbientProbe {
  return { sceneHash: 1, newElements: 10, hasContent: true, ...overrides };
}

const capture = async () => ({ recognized_text: "two pointers, sorted" });

describe("shouldAnalyze", () => {
  it("analyses the first board with anything on it", () => {
    expect(shouldAnalyze(probe(), null)).toEqual({ analyze: true });
  });

  it("skips an unchanged board — the main cost control", () => {
    expect(shouldAnalyze(probe({ sceneHash: 7 }), 7)).toEqual({
      analyze: false,
      reason: "unchanged",
    });
  });

  it("skips an empty board", () => {
    expect(shouldAnalyze(probe({ hasContent: false }), null)).toEqual({
      analyze: false,
      reason: "empty",
    });
  });

  it("waits for enough new work rather than nudging on a stray dot", () => {
    expect(shouldAnalyze(probe({ sceneHash: 8, newElements: 1 }), 7)).toEqual({
      analyze: false,
      reason: "too-little-new",
    });
    expect(shouldAnalyze(probe({ sceneHash: 8, newElements: MIN_NEW_ELEMENTS }), 7)).toEqual({
      analyze: true,
    });
  });

  it("does not apply the stroke threshold to the very first look", () => {
    expect(shouldAnalyze(probe({ newElements: 1 }), null)).toEqual({ analyze: true });
  });
});

/** A socket that records what was sent and lets tests fire events. */
function fakeSocket() {
  const sent: string[] = [];
  const socket: WebSocketLike & { sent: string[] } = {
    sent,
    send: (data) => void sent.push(data),
    close: () => {},
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  return socket;
}

describe("AmbientCoach", () => {
  const pairing = { baseUrl: "http://127.0.0.1:7878", token: null };

  it("says hello with the problem on the board", () => {
    const socket = fakeSocket();
    const coach = new AmbientCoach(pairing, { onFrame: () => {} }, () => socket, "s1");
    coach.start("two-sum", probe, capture, 1_000_000);
    socket.onopen?.({});

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "hello",
      session_id: "s1",
      task_id: "two-sum",
    });
    coach.stop();
  });

  it("captures only when the board changed", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const skips: string[] = [];
    let captures = 0;
    let current = probe({ sceneHash: 100 });

    const countingCapture = async () => {
      captures += 1;
      return { recognized_text: "two pointers" };
    };

    const coach = new AmbientCoach(
      pairing,
      { onFrame: () => {}, onSkip: (reason) => skips.push(reason) },
      () => socket,
      "s1",
    );
    coach.start("two-sum", () => current, countingCapture, 15_000);
    socket.onopen?.({});

    await vi.advanceTimersByTimeAsync(15_000);
    expect(captures).toBe(1);
    expect(JSON.parse(socket.sent[1])).toMatchObject({
      type: "snapshot",
      task_id: "two-sum",
      scene_hash: 100,
      recognized_text: "two pointers",
    });

    // Same board: no capture, no traffic. Recognition is never even attempted.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(captures).toBe(1);
    expect(socket.sent).toHaveLength(2);
    expect(skips).toEqual(["unchanged"]);

    // New work: it captures and sends again.
    current = probe({ sceneHash: 200 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(captures).toBe(2);
    expect(JSON.parse(socket.sent[2]).scene_hash).toBe(200);

    coach.stop();
    vi.useRealTimers();
  });

  it("does not overlap a slow capture with the next tick", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    let captures = 0;
    // A promise the test resolves by hand, so the capture stays in flight while
    // later ticks fire.
    const gate: { release: () => void } = { release: () => {} };
    const inFlight = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const slowCapture = async () => {
      captures += 1;
      await inFlight;
      return { recognized_text: "slow" };
    };

    const coach = new AmbientCoach(pairing, { onFrame: () => {} }, () => socket, "s1");
    let hash = 1;
    coach.start("two-sum", () => probe({ sceneHash: hash++ }), slowCapture, 15_000);
    socket.onopen?.({});

    await vi.advanceTimersByTimeAsync(15_000);
    expect(captures).toBe(1);
    // Two more ticks fire while the first capture is still in flight.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(captures).toBe(1);

    gate.release();
    coach.stop();
    vi.useRealTimers();
  });

  it("stops ticking once stopped", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const coach = new AmbientCoach(pairing, { onFrame: () => {} }, () => socket, "s1");
    coach.start("two-sum", probe, capture, 15_000);
    socket.onopen?.({});
    coach.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.sent).toHaveLength(1); // Only the hello.
    vi.useRealTimers();
  });

  it("hands parsed frames to the handler", () => {
    const socket = fakeSocket();
    const frames: ServerFrame[] = [];
    const coach = new AmbientCoach(pairing, { onFrame: (f) => frames.push(f) }, () => socket, "s1");
    coach.start("two-sum", probe, capture, 1_000_000);

    socket.onmessage?.({
      data: JSON.stringify({
        type: "nudge",
        confidence: 0.7,
        guessed_approach: "hash map",
        closeness: "warm",
        nudge: "what about duplicates?",
        nudges_so_far: 1,
      }),
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "nudge", closeness: "warm" });
    coach.stop();
  });

  it("reports an unreadable frame instead of throwing", () => {
    const socket = fakeSocket();
    const errors: string[] = [];
    const coach = new AmbientCoach(
      pairing,
      { onFrame: () => {}, onError: (m) => errors.push(m) },
      () => socket,
      "s1",
    );
    coach.start("two-sum", probe, capture, 1_000_000);
    socket.onmessage?.({ data: "not json" });
    expect(errors).toEqual(["unreadable frame from the coach"]);
    coach.stop();
  });

  it("surfaces a recognition failure without killing the loop", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const errors: string[] = [];
    const coach = new AmbientCoach(
      pairing,
      { onFrame: () => {}, onError: (m) => errors.push(m) },
      () => socket,
      "s1",
    );
    let hash = 1;
    coach.start(
      "two-sum",
      () => probe({ sceneHash: hash++ }),
      async () => {
        throw new Error("ink recognizer unavailable");
      },
      15_000,
    );
    socket.onopen?.({});

    await vi.advanceTimersByTimeAsync(15_000);
    expect(errors).toEqual(["ink recognizer unavailable"]);
    // Still ticking.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(errors).toHaveLength(2);

    coach.stop();
    vi.useRealTimers();
  });

  it("resets the ladder and re-analyses the same board afterwards", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const coach = new AmbientCoach(pairing, { onFrame: () => {} }, () => socket, "s1");
    coach.start("two-sum", () => probe({ sceneHash: 5 }), capture, 15_000);
    socket.onopen?.({});

    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.sent).toHaveLength(2); // Unchanged, skipped.

    coach.reset();
    expect(JSON.parse(socket.sent[2])).toEqual({ type: "reset", session_id: "s1" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.sent).toHaveLength(4); // Same board, but the ladder is clear.

    coach.stop();
    vi.useRealTimers();
  });
});
