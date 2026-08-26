/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";

import type { LcClient } from "../api/client";
import { LcApiError } from "../api/client";
import { snapshotHub, walkPushPad, type WalkPad, type WalkSnapshot } from "./hubWalk";

function fakeClient() {
  return {
    pingPadSync: vi.fn().mockResolvedValue({ now: 1 }),
    putAnnotatePad: vi.fn().mockResolvedValue({ id: "p1", updated_at: 900 }),
    putWhiteboardPad: vi.fn().mockResolvedValue({ id: "w1", updated_at: 900 }),
  } as unknown as LcClient & Record<string, ReturnType<typeof vi.fn>>;
}

function pad(overrides: Partial<WalkPad> = {}): WalkPad {
  return {
    kind: "annotate",
    id: "p1",
    hubAckUpdatedAt: () => 500,
    buildBody: () => ({ id: "p1", updated_at: 600 }) as never,
    ...overrides,
  };
}

const emptySnapshot: WalkSnapshot = {
  annotateRows: [],
  whiteboardRows: [],
  inkDigests: [],
  edges: [],
  goneEdges: [],
};

describe("walkPushPad (stage E)", () => {
  it("pushes when the hub has nothing newer than our last acknowledged write", async () => {
    const client = fakeClient();
    const result = await walkPushPad(client, pad(), emptySnapshot);
    expect(result).toEqual({ outcome: "ok", hubUpdatedAt: 900 });
    expect(client.putAnnotatePad).toHaveBeenCalledTimes(1);
  });

  it("stops before pushing when the hub row moved since our last write", async () => {
    const client = fakeClient();
    // Hub row is at 800; we only ever saw up to 500. Pushing would be LWW.
    const result = await walkPushPad(client, pad(), {
      ...emptySnapshot,
      annotateRows: [{ id: "p1", updated_at: 800 }],
    });
    expect(result.outcome).toBe("conflict");
    if (result.outcome === "conflict") expect(result.hubUpdatedAt).toBe(800);
    expect(client.putAnnotatePad).not.toHaveBeenCalled();
  });

  it("treats tombstoned hub rows as absent", async () => {
    const client = fakeClient();
    const result = await walkPushPad(client, pad(), {
      ...emptySnapshot,
      annotateRows: [{ id: "p1", updated_at: 800, deleted_at: 801 }],
    });
    expect(result.outcome).toBe("ok");
    expect(client.putAnnotatePad).toHaveBeenCalledTimes(1);
  });

  it("turns a 409 into a conflict without queueing or retrying", async () => {
    const client = fakeClient();
    client.putAnnotatePad = vi.fn().mockRejectedValue(new LcApiError("base mismatch", 409));
    const result = await walkPushPad(client, pad(), emptySnapshot);
    expect(result.outcome).toBe("conflict");
    expect(client.putAnnotatePad).toHaveBeenCalledTimes(1);
  });

  it("rethrows network failures — the walk fails loudly instead of queueing", async () => {
    const client = fakeClient();
    client.putAnnotatePad = vi.fn().mockRejectedValue(new LcApiError("socket closed", 0));
    await expect(walkPushPad(client, pad(), emptySnapshot)).rejects.toThrow("socket closed");
  });
});

describe("snapshotHub", () => {
  it("normalizes the ping into what the stages read", async () => {
    const client = fakeClient();
    client.pingPadSync = vi.fn().mockResolvedValue({
      now: 5,
      annotate: [{ id: "a", updated_at: 1 }],
      whiteboard: [],
      ink: [{ kind: "annotate", key: "a", page_id: 2, updated_at: 3 }],
      edges: [{ id: "e1" }],
      gone_edges: ["e2"],
    });
    const snap = await snapshotHub(client as unknown as LcClient);
    expect(snap.annotateRows).toHaveLength(1);
    expect(snap.inkDigests[0]?.page_id).toBe(2);
    expect(snap.goneEdges).toEqual(["e2"]);
  });
});
