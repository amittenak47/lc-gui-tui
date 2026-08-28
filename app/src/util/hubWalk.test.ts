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

describe("walkSyncInk (stage F)", () => {
  /*
   * The ink page store is IndexedDB; these tests only need the *transfer* to
   * fail, so the store is stubbed to hold one dirty page and nothing else.
   */
  function stubStores(local: Array<{ pageId: number; updatedAt: number }>) {
    const keys: string[] = [];
    vi.doMock("./inkPageStore", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./inkPageStore")>()),
      getInkPageRecords: (docKey: string) => {
        keys.push(docKey);
        return Promise.resolve(
          local.map((row) => ({ ...row, gz: new Uint8Array([1, 2, 3]) })),
        );
      },
      writeInkPage: () => Promise.resolve(),
    }));
    return keys;
  }

  it("fails the walk when the hub will not take the strokes", async () => {
    // Both directions used to be swallowed, and the stage returned "ok"
    // regardless — so a hub that went away mid-stage still ended the walk on
    // "Synced" with the handwriting still only on this device.
    vi.resetModules();
    stubStores([{ pageId: 1, updatedAt: 900 }]);
    vi.doMock("./padHub", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./padHub")>()),
      loadPadHub: () => ({ url: "http://hub.test", token: "t" }),
    }));
    const { walkSyncInk: walk } = await import("./hubWalk");

    const client = {
      getInkPages: vi.fn().mockResolvedValue([]),
      putInkPage: vi.fn().mockRejectedValue(new Error("hub went away")),
    } as unknown as LcClient;

    await expect(
      walk(client, pad(), emptySnapshot, 0),
    ).rejects.toThrow("hub went away");
    vi.doUnmock("./inkPageStore");
    vi.doUnmock("./padHub");
    vi.resetModules();
  });

  it("reports ok when every page moved", async () => {
    vi.resetModules();
    stubStores([{ pageId: 1, updatedAt: 900 }]);
    vi.doMock("./padHub", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./padHub")>()),
      loadPadHub: () => ({ url: "http://hub.test", token: "t" }),
    }));
    const { walkSyncInk: walk } = await import("./hubWalk");

    const client = {
      getInkPages: vi.fn().mockResolvedValue([]),
      putInkPage: vi.fn().mockResolvedValue(undefined),
    } as unknown as LcClient;

    await expect(walk(client, pad(), emptySnapshot, 0)).resolves.toEqual({
      outcome: "ok",
    });
    vi.doUnmock("./inkPageStore");
    vi.doUnmock("./padHub");
    vi.resetModules();
  });

  it("fails the walk when a digest page is missing from the GET body", async () => {
    // Strict pull used to `continue` on a named page with no payload, so the
    // walk could still reach Synced with strokes that never landed here.
    vi.resetModules();
    stubStores([]);
    vi.doMock("./padHub", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./padHub")>()),
      loadPadHub: () => ({ url: "http://hub.test", token: "t" }),
    }));
    const { walkSyncInk: walk } = await import("./hubWalk");

    const client = {
      getInkPages: vi.fn().mockResolvedValue([]),
      putInkPage: vi.fn(),
    } as unknown as LcClient;

    await expect(
      walk(
        client,
        pad(),
        {
          ...emptySnapshot,
          inkDigests: [{ kind: "annotate", key: "p1", page_id: 2, updated_at: 50 }],
        },
        0,
      ),
    ).rejects.toThrow(/missing from the hub download/);
    vi.doUnmock("./inkPageStore");
    vi.doUnmock("./padHub");
    vi.resetModules();
  });

  it("looks up local pages under md:id, not annotate:id", async () => {
    vi.resetModules();
    const keys = stubStores([]);
    vi.doMock("./padHub", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./padHub")>()),
      loadPadHub: () => ({ url: "http://hub.test", token: "t" }),
    }));
    const { walkSyncInk: walk } = await import("./hubWalk");
    const client = {
      getInkPages: vi.fn().mockResolvedValue([]),
      putInkPage: vi.fn(),
    } as unknown as LcClient;

    await expect(
      walk(
        client,
        pad(),
        {
          ...emptySnapshot,
          inkDigests: [{ kind: "annotate", key: "p1", page_id: 2, updated_at: 50 }],
        },
        0,
      ),
    ).rejects.toThrow(/missing from the hub download/);
    expect(keys.some((key) => key === "md:p1")).toBe(true);
    expect(keys.some((key) => key === "annotate:p1")).toBe(false);
    vi.doUnmock("./inkPageStore");
    vi.doUnmock("./padHub");
    vi.resetModules();
  });
});
