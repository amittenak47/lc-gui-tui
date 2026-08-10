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

  it("routes frames by request id so a nudge cannot land on a run", async () => {
    const socket = fakeSocket();
    const ambient: ServerFrame[] = [];
    const process: string[] = [];
    const coach = new AmbientCoach(
      pairing,
      { onFrame: (frame) => ambient.push(frame) },
      () => socket,
      "s1",
    );
    coach.connect("two-sum");
    socket.onopen?.({});

    const answered = coach.run<{ verdict: string }>(
      "review",
      { task_id: "two-sum", recognized_text: "two pointers" },
      { onProcess: (event) => process.push(`${event.kind}:${event.label}`) },
    );
    const sent = JSON.parse(socket.sent[1]);
    expect(sent).toMatchObject({
      type: "run",
      action: "review",
      payload: { task_id: "two-sum", recognized_text: "two pointers" },
    });
    const requestId = sent.request_id as string;
    expect(coach.busy).toBe(true);

    socket.onmessage?.({
      data: JSON.stringify({
        type: "stage",
        request_id: requestId,
        stage: "claim",
        detail: "naming the approach",
      }),
    });
    // An ambient nudge arriving mid-run belongs to the ambient handler alone.
    socket.onmessage?.({
      data: JSON.stringify({ type: "thinking" }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "tool_event",
        request_id: requestId,
        name: "draw_structure",
        status: "rejected",
        summary: "array",
        reason: "no frames",
      }),
    });
    // A stage for a request nobody is waiting on is dropped, not misfiled.
    socket.onmessage?.({
      data: JSON.stringify({ type: "stage", request_id: "someone-else", stage: "code", detail: "" }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "result",
        request_id: requestId,
        action: "review",
        body: { verdict: "on_track" },
      }),
    });

    await expect(answered).resolves.toEqual({ verdict: "on_track" });
    expect(process).toEqual(["stage:claim", "tool:draw_structure"]);
    expect(ambient.map((frame) => frame.type)).toEqual(["thinking"]);
    expect(coach.busy).toBe(false);
    coach.stop();
  });

  it("rejects a run on an error that names it, and leaves ambient errors alone", async () => {
    const socket = fakeSocket();
    const ambient: ServerFrame[] = [];
    const coach = new AmbientCoach(
      pairing,
      { onFrame: (frame) => ambient.push(frame) },
      () => socket,
      "s1",
    );
    coach.connect("two-sum");
    socket.onopen?.({});

    const answered = coach.run("ask", { task_id: "two-sum", question: "why?" });
    const requestId = JSON.parse(socket.sent[1]).request_id as string;

    socket.onmessage?.({
      data: JSON.stringify({ type: "error", message: "the ambient model is down" }),
    });
    socket.onmessage?.({
      data: JSON.stringify({ type: "error", request_id: requestId, message: "busy" }),
    });

    await expect(answered).rejects.toThrow("busy");
    expect(ambient).toEqual([{ type: "error", message: "the ambient model is down" }]);
    coach.stop();
  });

  it("fails waiting runs when an old daemon cannot parse a run frame", async () => {
    const socket = fakeSocket();
    const ambient: ServerFrame[] = [];
    const coach = new AmbientCoach(
      pairing,
      { onFrame: (frame) => ambient.push(frame) },
      () => socket,
      "s1",
    );
    coach.connect("two-sum");
    socket.onopen?.({});

    const answered = coach.run("ask", { task_id: "two-sum", question: "why?" });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "error",
        message:
          "cannot parse frame: unknown variant `run`, expected one of `hello`, `snapshot`, `reset`",
      }),
    });

    await expect(answered).rejects.toThrow(/cannot parse frame/);
    // Swallowed as a run failure so the UI can fall back to HTTP — not ambient noise.
    expect(ambient).toEqual([]);
    await expect(coach.run("ask", { task_id: "two-sum", question: "again?" })).rejects.toThrow(
      /no run frames/,
    );
    coach.stop();
  });

  it("queues a run sent before the handshake instead of dropping it", () => {
    const socket = fakeSocket();
    const coach = new AmbientCoach(pairing, { onFrame: () => {} }, () => socket, "s1");
    coach.connect("two-sum");

    void coach.run("ask", { task_id: "two-sum", question: "why?" }).catch(() => {});
    expect(socket.sent).toHaveLength(0);

    socket.onopen?.({});
    // Hello first, then the queued run — the daemon needs the session named.
    expect(JSON.parse(socket.sent[0]).type).toBe("hello");
    expect(JSON.parse(socket.sent[1])).toMatchObject({ type: "run", action: "ask" });
    coach.stop();
  });

  it("cancels an in-flight run when the socket is torn down", async () => {
    const socket = fakeSocket();
    const coach = new AmbientCoach(pairing, { onFrame: () => {} }, () => socket, "s1");
    coach.connect("two-sum");
    socket.onopen?.({});

    const answered = coach.run("review", { task_id: "two-sum" });
    const requestId = JSON.parse(socket.sent[1]).request_id as string;
    coach.stop();

    expect(JSON.parse(socket.sent[2])).toEqual({ type: "cancel", request_id: requestId });
    await expect(answered).rejects.toThrow("stopped before it answered");
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

/**
 * A run that never answers.
 *
 * This is the bug these cover: `run()` used to settle only on a frame naming
 * its request id, so a daemon that accepted the frame and went quiet — or a
 * frame that never made it onto the wire at all — left the promise pending and
 * the turn on "Working…" for the rest of the session.
 */
describe("AmbientCoach.run — a run always settles", () => {
  const pairing = { baseUrl: "http://127.0.0.1:7878", token: null };

  function ready() {
    const socket = fakeSocket();
    const coach = new AmbientCoach(pairing, { onFrame: () => {} }, () => socket, "s1");
    coach.connect("two-sum");
    socket.onopen?.({});
    socket.sent.length = 0;
    return { socket, coach };
  }

  function requestIdOf(socket: ReturnType<typeof fakeSocket>): string {
    const frame = socket.sent.map((raw) => JSON.parse(raw)).find((f) => f.type === "run");
    return frame.request_id as string;
  }

  it("rejects when the frame is too large to put on the wire", async () => {
    const socket = fakeSocket();
    const errors: string[] = [];
    const coach = new AmbientCoach(
      pairing,
      { onFrame: () => {}, onError: (message) => errors.push(message) },
      () => socket,
      "s1",
    );
    coach.connect("two-sum");
    socket.onopen?.({});
    socket.send = () => {
      throw new Error("message too big");
    };

    await expect(coach.run("ask", { question: "hi" })).rejects.toThrow(/too large/i);
    expect(errors).toContain("could not reach the coach");
    expect(coach.busy).toBe(false);
    coach.stop();
  });

  it("gives up quickly on a run the daemon never picks up", async () => {
    vi.useFakeTimers();
    const { socket, coach } = ready();
    const promise = coach.run("ask", { question: "hi" });
    const expectation = expect(promise).rejects.toThrow(/never picked up/i);

    // Short budget: an unacknowledged request is already known to be lost, and
    // waiting the full working budget only delays telling the reader.
    await vi.advanceTimersByTimeAsync(25_000);
    await expectation;

    const cancels = socket.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === "cancel");
    expect(cancels).toHaveLength(1);
    expect(coach.busy).toBe(false);
    coach.stop();
    vi.useRealTimers();
  });

  it("gives a claimed run the long budget, and names where it stalled", async () => {
    vi.useFakeTimers();
    const { socket, coach } = ready();
    const promise = coach.run("ask", { question: "hi" });
    const requestId = requestIdOf(socket);
    const expectation = expect(promise).rejects.toThrow(/during .drafting./i);

    socket.onmessage?.({
      data: JSON.stringify({ type: "stage", request_id: requestId, stage: "drafting" }),
    });
    // Past the ack budget, inside the working one: an acknowledged run is not
    // killed at 20s just because the model is slow.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(coach.busy).toBe(true);

    await vi.advanceTimersByTimeAsync(160_000);
    await expectation;
    coach.stop();
    vi.useRealTimers();
  });

  it("blames the failed step when a stall follows one", async () => {
    vi.useFakeTimers();
    const { socket, coach } = ready();
    const promise = coach.run("ask", { question: "hi" });
    const requestId = requestIdOf(socket);
    const expectation = expect(promise).rejects.toThrow(/after search failed/i);

    socket.onmessage?.({
      data: JSON.stringify({ type: "stage", request_id: requestId, stage: "drafting" }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "tool_event",
        request_id: requestId,
        name: "search",
        status: "rejected",
        summary: "no results",
      }),
    });
    await vi.advanceTimersByTimeAsync(220_000);
    await expectation;
    coach.stop();
    vi.useRealTimers();
  });

  it("keeps waiting while the daemon reports progress", async () => {
    vi.useFakeTimers();
    const { socket, coach } = ready();
    const promise = coach.run<{ reply: string }>("ask", { question: "hi" });
    const requestId = requestIdOf(socket);

    // Claimed straight away, then a stage every 90s: silent by no measure,
    // but past any naive total deadline.
    socket.onmessage?.({
      data: JSON.stringify({ type: "stage", request_id: requestId, stage: "claim" }),
    });
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(90_000);
      socket.onmessage?.({
        data: JSON.stringify({ type: "stage", request_id: requestId, stage: "thinking" }),
      });
    }
    socket.onmessage?.({
      data: JSON.stringify({
        type: "result",
        request_id: requestId,
        action: "ask",
        body: { reply: "here" },
      }),
    });

    await expect(promise).resolves.toEqual({ reply: "here" });
    coach.stop();
    vi.useRealTimers();
  });

  it("stops the watchdog once a run has answered", async () => {
    vi.useFakeTimers();
    const { socket, coach } = ready();
    const promise = coach.run<{ reply: string }>("ask", { question: "hi" });
    const requestId = requestIdOf(socket);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "result",
        request_id: requestId,
        action: "ask",
        body: { reply: "here" },
      }),
    });
    await expect(promise).resolves.toEqual({ reply: "here" });

    // Nothing left to fire: a late watchdog would send a cancel for a run that
    // already answered, which the daemon would apply to whatever replaced it.
    socket.sent.length = 0;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(socket.sent).toEqual([]);
    coach.stop();
    vi.useRealTimers();
  });

  it("rejects a run queued on a socket that never opens", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const coach = new AmbientCoach(pairing, { onFrame: () => {} }, () => socket, "s1");
    coach.connect("two-sum");
    // No `onopen` — the frame sits in the outbox.
    const promise = coach.run("ask", { question: "hi" });
    const expectation = expect(promise).rejects.toThrow(/never picked up/i);
    await vi.advanceTimersByTimeAsync(25_000);
    await expectation;
    coach.stop();
    vi.useRealTimers();
  });
});
