/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { HubSyncControl, type HubSyncWalkHost } from "./HubSyncControl";
import type { LcClient } from "../api/client";
import { PAD_HUB_KEY } from "../util/padHub";

vi.mock("../util/docExtract", () => ({
  extractDocumentPages: vi.fn(
    async (input: { onProgress?: (done: number, total: number) => void }) => {
      input.onProgress?.(1, 2);
      input.onProgress?.(2, 2);
      return [{ page: 1, text: "hello", heading: "h" }];
    },
  ),
}));

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<HubSyncControl />));
  const button = host.querySelector(".lc-hub-sync") as HTMLButtonElement;
  return { host, root, button };
}

// The morph bar keeps every panel mounted (hidden ones are only
// aria-hidden), so read the label off whichever panel is active.
function activeLabel(button: HTMLButtonElement): string | null | undefined {
  return button.querySelector(".lc-morph-panel.is-active")?.textContent;
}

describe("HubSyncControl (step-2 stub)", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.textContent = "";
  });

  it("starts idle on Sync and walks the stage labels after one tap", () => {
    vi.useFakeTimers();
    const { button } = mount();
    expect(button.dataset.stage).toBe("idle");
    expect(activeLabel(button)).toBe("Sync");

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.dataset.stage).toBe("index");

    // One tap walks the whole pipeline; no further clicks needed.
    for (const next of ["pad", "ink", "links", "pull", "synced"]) {
      act(() => {
        vi.advanceTimersByTime(650);
      });
      expect(button.dataset.stage).toBe(next);
    }
    expect(button.dataset.stage).toBe("synced");
    expect(activeLabel(button)).toBe("Synced");
  });

  it("ignores taps mid-walk and resets to Sync once finished", () => {
    vi.useFakeTimers();
    const { button } = mount();

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.dataset.stage).toBe("index");

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.dataset.stage).toBe("index");

    // Chained timers reschedule on the effect flush after each step, so
    // walk one stage per act.
    for (let i = 0; i < 5; i++) {
      act(() => {
        vi.advanceTimersByTime(650);
      });
    }
    expect(button.dataset.stage).toBe("synced");

    // One tap on a finished pill runs the walk again. It used to reset to
    // Sync and need a second tap for the thing the first one asked for.
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.dataset.stage).toBe("index");
    expect(activeLabel(button)).toBe("Index");
  });

  it("rests on Synced when the hint says the hub already has everything", () => {
    vi.useFakeTimers();
    const hint = {
      hash: "h",
      padUpdatedAt: 500,
      padUpToDate: true,
      bytesOnHub: true,
      indexedOnHub: true,
    };
    function Host({ value }: { value: typeof hint | null }) {
      return <HubSyncControl hubHint={value} />;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<Host value={null} />));
    const button = host.querySelector(".lc-hub-sync") as HTMLButtonElement;
    expect(activeLabel(button)).toBe("Sync");

    // Hint arriving after first paint flips the idle label to Synced...
    act(() => root.render(<Host value={hint} />));
    expect(activeLabel(button)).toBe("Synced");

    // ...and tapping from there still starts the walk at Index.
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.dataset.stage).toBe("index");
  });

  it("stops resting on Synced once the pad has been edited", () => {
    const hint = {
      hash: "h",
      padUpdatedAt: 500,
      padUpToDate: true,
      bytesOnHub: true,
      indexedOnHub: true,
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<HubSyncControl hubHint={hint} editSeq={0} />));
    const button = host.querySelector(".lc-hub-sync") as HTMLButtonElement;
    expect(activeLabel(button)).toBe("Synced");

    act(() => root.render(<HubSyncControl hubHint={hint} editSeq={1} />));
    expect(activeLabel(button)).toBe("Sync");
    act(() => root.unmount());
  });

  it("stays on Sync when the hub row is older than what opened locally", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <HubSyncControl
          hubHint={{
            hash: "h",
            padUpdatedAt: 100,
            padUpToDate: false,
            bytesOnHub: true,
            indexedOnHub: true,
          }}
        />,
      );
    });
    const button = host.querySelector(".lc-hub-sync") as HTMLButtonElement;
    expect(activeLabel(button)).toBe("Sync");
  });

  describe("walk (stages A–D live)", () => {
    /*
     * A wired pill only exists where there is a hub — see `HubSyncControl`.
     * Every stage below talks to one, so the tests say so out loud.
     */
    beforeEach(() => {
      // This harness's jsdom has no `localStorage`, so the hub is stubbed in
      // rather than written — same read path, no dependency on the shim.
      const store = new Map<string, string>([
        [PAD_HUB_KEY, JSON.stringify({ url: "http://hub.test", token: "t" })],
      ]);
      vi.stubGlobal("localStorage", {
        get length() {
          return store.size;
        },
        clear: () => store.clear(),
        getItem: (key: string) => store.get(key) ?? null,
        key: (i: number) => [...store.keys()][i] ?? null,
        removeItem: (key: string) => void store.delete(key),
        setItem: (key: string, value: string) => void store.set(key, value),
      });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function fakeClient(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
      const notIndexed = {
        hash: "h",
        indexed: false,
        page_count: 0,
        chunk_count: 0,
        embedded: false,
      };
      const fns = {
        pingPadSync: overrides.pingPadSync ?? vi.fn().mockResolvedValue({ now: 1 }),
        getDocIndex:
          overrides.getDocIndex ??
          vi
            .fn()
            .mockResolvedValueOnce(notIndexed)
            .mockResolvedValueOnce({ ...notIndexed, indexed: true, page_count: 3, embed_state: "full" }),
        indexFromBytes: overrides.indexFromBytes ?? vi.fn().mockResolvedValue({ indexed: true }),
        putDocIndex: overrides.putDocIndex ?? vi.fn().mockResolvedValue({ indexed: true }),
        embedDoc: overrides.embedDoc ?? vi.fn(),
        putDocBytes: overrides.putDocBytes ?? vi.fn().mockResolvedValue(undefined),
        // The hub already holds the file unless a test says otherwise.
        docBytesOnHub: overrides.docBytesOnHub ?? vi.fn().mockResolvedValue(true),
        listAnnotatePads: overrides.listAnnotatePads ?? vi.fn().mockResolvedValue([]),
        listWhiteboardPads: overrides.listWhiteboardPads ?? vi.fn().mockResolvedValue([]),
        // One pad, by id — the conflict path no longer lists the library.
        getAnnotatePad: overrides.getAnnotatePad ?? vi.fn().mockResolvedValue(null),
        getWhiteboardPad: overrides.getWhiteboardPad ?? vi.fn().mockResolvedValue(null),
        putAnnotatePad:
          overrides.putAnnotatePad ??
          vi.fn().mockResolvedValue({ id: "pad-1", updated_at: 900 }),
        putWhiteboardPad:
          overrides.putWhiteboardPad ??
          vi.fn().mockResolvedValue({ id: "w1", updated_at: 900 }),
        putEdges: overrides.putEdges ?? vi.fn().mockResolvedValue(undefined),
        tombstoneEdge: overrides.tombstoneEdge ?? vi.fn().mockResolvedValue(undefined),
      };
      return fns as unknown as LcClient & Record<string, ReturnType<typeof vi.fn>>;
    }

    function makeHost(doc: HubSyncWalkHost["doc"] extends () => infer R ? R : never) {
      const progress = vi.fn();
      const errors = vi.fn();
      const indexDone = vi.fn();
      const walkReports: Array<{ stage: string; job?: string | null } | null> = [];
      const reload = vi.fn();
      const conflicts: unknown[] = [];
      const picks: Array<{ pick: "local" | "server" }> = [];
      const host: HubSyncWalkHost = {
        doc: () => doc,
        pad: async () => null,
        emitReload: () => reload(),
        inkSince: () => 0,
        onConflict: (conflict) => {
          conflicts.push(conflict);
          return Promise.resolve(picks.shift() ?? { pick: "server" });
        },
        onIndexProgress: (p) => progress(p),
        onWalkProgress: (report) => walkReports.push(report),
        onIndexError: (m) => errors(m),
        onIndexDone: () => indexDone(),
      };
      return { host, progress, errors, indexDone, walkReports, reload, conflicts, picks };
    }

    /**
     * Give a host a pad row.
     *
     * `makeHost` answers `pad: () => null`, which is a document opened to read
     * and never saved. A walk over that one ends on idle Sync — Pad, Ink and
     * Pull have no row to act on — so anything asserting "Synced" has to have
     * something to sync.
     */
    function withPad(host: HubSyncWalkHost, ack = 100): HubSyncWalkHost {
      (host as unknown as { pad: () => Promise<unknown> }).pad = async () => ({
        kind: "annotate" as const,
        id: "pad-1",
        hubAckUpdatedAt: () => ack,
        buildBody: () => ({ id: "pad-1", name: "book.pdf", updated_at: 900 }),
        markHubAck: () => {},
      });
      return host;
    }

    async function mountWalk(client: LcClient, host: HubSyncWalkHost) {
      const hostEl = document.createElement("div");
      document.body.append(hostEl);
      const root = createRoot(hostEl);
      act(() => root.render(<HubSyncControl client={client} host={host} />));
      return hostEl.querySelector(".lc-hub-sync") as HTMLButtonElement;
    }

    it("is not offered at all when no hub is configured", async () => {
      // Every stage talks to a hub. `indexFromBytes` had no local route and
      // used to force-unwrap the missing one, so tapping this on a device that
      // syncs with nothing failed on a null dereference at stage C.
      vi.stubGlobal("localStorage", {
        length: 0,
        clear: () => {},
        getItem: () => null,
        key: () => null,
        removeItem: () => {},
        setItem: () => {},
      });
      const client = fakeClient();
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const hostEl = document.createElement("div");
      document.body.append(hostEl);
      const root = createRoot(hostEl);
      act(() => root.render(<HubSyncControl client={client} host={host} />));

      expect(hostEl.querySelector(".lc-hub-sync")).toBeNull();
      expect(
        (client as unknown as { pingPadSync: ReturnType<typeof vi.fn> }).pingPadSync,
      ).not.toHaveBeenCalled();
      act(() => root.unmount());
    });

    it("mounts on the host, which has a loopback rather than a saved hub", async () => {
      /*
       * The desktop that *is* the hub leaves Connect empty on purpose — its
       * card says "type these into the tablet" — so `loadSavedPadHub` is null
       * there and the pill never mounted on the machine holding the library.
       */
      vi.stubGlobal("localStorage", {
        length: 0,
        clear: () => {},
        getItem: () => null,
        key: () => null,
        removeItem: () => {},
        setItem: () => {},
      });
      const { setHostLoopback } = await import("../util/padHub");
      setHostLoopback({ url: "http://127.0.0.1:7878", token: "t" });

      const client = fakeClient();
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const hostEl = document.createElement("div");
      document.body.append(hostEl);
      const root = createRoot(hostEl);
      act(() => root.render(<HubSyncControl client={client} host={host} />));

      expect(hostEl.querySelector(".lc-hub-sync")).not.toBeNull();
      act(() => root.unmount());
      setHostLoopback(null);
    });

    it("refuses to walk if the hub disappears between mount and tap", async () => {
      vi.useFakeTimers();
      const client = fakeClient();
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const button = await mountWalk(client, host);

      // Settings cleared it after this pill mounted; stage A must catch that
      // rather than letting stage C find out inside the fetch.
      const empty = {
        length: 0,
        clear: () => {},
        getItem: () => null,
        key: () => null,
        removeItem: () => {},
        setItem: () => {},
      };
      vi.stubGlobal("localStorage", empty);

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      expect(button.dataset.stage).toBe("index");
      expect(button.dataset.error).toContain("no hub");
      expect(
        (client as unknown as { indexFromBytes: ReturnType<typeof vi.fn> }).indexFromBytes,
      ).not.toHaveBeenCalled();
    });

    it("indexes from bytes and lands on Synced after one tap", async () => {
      vi.useFakeTimers();
      const client = fakeClient();
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const button = await mountWalk(client, withPad(host));

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      expect((client as unknown as typeof client & { indexFromBytes: ReturnType<typeof vi.fn> }).indexFromBytes)
        .toHaveBeenCalledWith("h", { name: "book.pdf", doc_type: "pdf", source_text: undefined });
      expect(button.dataset.stage).toBe("synced");
    });

    it("uploads the bytes when the hub does not have them yet", async () => {
      /*
       * The upload used to be gated on the *index* status being null or an
       * open-time hint saying the bytes were missing. A hub that answered
       * `{ indexed: false }` — which is not null — with no hint yet skipped
       * the upload, and then stage C asked it to extract from a file it had
       * never been sent.
       */
      vi.useFakeTimers();
      const putDocBytes = vi.fn().mockResolvedValue(undefined);
      const docBytesOnHub = vi.fn().mockResolvedValue(false);
      const client = fakeClient({
        putDocBytes,
        docBytesOnHub,
        getDocIndex: vi
          .fn()
          .mockResolvedValueOnce({
            hash: "h",
            indexed: false,
            page_count: 0,
            chunk_count: 0,
            embedded: false,
          })
          .mockResolvedValue({
            hash: "h",
            indexed: true,
            page_count: 3,
            chunk_count: 1,
            embedded: true,
            embed_state: "full",
          }),
      });
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: new ArrayBuffer(8),
      });
      const button = await mountWalk(client, withPad(host));

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      expect(docBytesOnHub).toHaveBeenCalledWith("h");
      expect(putDocBytes).toHaveBeenCalledTimes(1);
      expect(
        (client as unknown as { putDocIndex: ReturnType<typeof vi.fn> }).putDocIndex,
      ).toHaveBeenCalled();
      expect(button.dataset.stage).toBe("synced");
    });

    it("does not re-upload a file the hub already holds", async () => {
      vi.useFakeTimers();
      const putDocBytes = vi.fn().mockResolvedValue(undefined);
      const client = fakeClient({
        putDocBytes,
        docBytesOnHub: vi.fn().mockResolvedValue(true),
      });
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: new ArrayBuffer(8),
      });
      const button = await mountWalk(client, withPad(host));

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      expect(putDocBytes).not.toHaveBeenCalled();
      expect(button.dataset.stage).toBe("synced");
    });

    it("parks on Index when neither side has the file", async () => {
      // Nothing to upload and nothing to extract from: walking on to Synced
      // would report a document as indexed that was never read.
      vi.useFakeTimers();
      const client = fakeClient({
        docBytesOnHub: vi.fn().mockResolvedValue(false),
      });
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const button = await mountWalk(client, withPad(host));

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      expect(button.dataset.stage).toBe("index");
      expect(button.dataset.error).toContain("does not have this file");
      expect(
        (client as unknown as { indexFromBytes: ReturnType<typeof vi.fn> }).indexFromBytes,
      ).not.toHaveBeenCalled();
    });

    it("skips extraction when the hub index already has pages", async () => {
      vi.useFakeTimers();
      const indexed = {
        hash: "h",
        indexed: true,
        page_count: 7,
        chunk_count: 2,
        embedded: false,
        embed_state: "full",
      };
      const client = fakeClient({ getDocIndex: vi.fn().mockResolvedValue(indexed) });
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const button = await mountWalk(client, withPad(host));

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      expect(
        (client as unknown as typeof client & { indexFromBytes: ReturnType<typeof vi.fn> }).indexFromBytes,
      ).not.toHaveBeenCalled();
      expect(button.dataset.stage).toBe("synced");
    });

    it("parks on Index with the error when the hub is down, and retries from there", async () => {
      vi.useFakeTimers();
      const pingPadSync = vi
        .fn()
        .mockRejectedValueOnce(new Error("hub unreachable"))
        .mockResolvedValueOnce({ now: 1 });
      const client = fakeClient({ pingPadSync });
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const button = await mountWalk(client, withPad(host));

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });
      // Parked on the failing stage's label with the error visible.
      expect(button.dataset.stage).toBe("index");
      expect(button.dataset.error).toContain("unreachable");
      expect(activeLabel(button)).toBe("Index");

      // Next tap retries; this time the hub answers.
      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });
      expect(button.dataset.stage).toBe("synced");
      expect(pingPadSync).toHaveBeenCalledTimes(2);
    });

    it("stops at Pad on a hub row that moved first; resolve with server skips the PUT", async () => {
      vi.useFakeTimers();
      const annotateRow = { id: "pad-1", updated_at: 500, deleted_at: null };
      const client = fakeClient({
        pingPadSync: vi.fn().mockResolvedValue({ now: 1, annotate: [annotateRow] }),
        getAnnotatePad: vi.fn().mockResolvedValue({
          id: "pad-1",
          name: "book.pdf",
          updated_at: 500,
          footnotes: [],
          source: "hub copy",
        }),
        putAnnotatePad: vi.fn(),
      });
      const { host, conflicts } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      // The open pad's ack is older than the hub row → E stops before applying.
      let padCalls = 0;
      (host as unknown as { pad: () => Promise<unknown> }).pad = async () => {
        padCalls++;
        return {
          kind: "annotate" as const,
          id: "pad-1",
          hubAckUpdatedAt: () => 100,
          buildBody: () => ({ id: "pad-1", name: "book.pdf", updated_at: 900 }),
          markHubAck: () => {},
        };
      };
      const button = await mountWalk(client, host);

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      // The stash held the frozen hub DTO while the split was open.
      expect(conflicts).toHaveLength(1);
      const conflict = conflicts[0] as { stage: string; server: { source?: string } | null };
      expect(conflict.stage).toBe("pad");
      expect(conflict.server?.source).toBe("hub copy");
      expect((client as unknown as { putAnnotatePad: ReturnType<typeof vi.fn> }).putAnnotatePad)
        .not.toHaveBeenCalled();
      expect(button.dataset.stage).toBe("synced");
    });

    it("after keep-local resolves, re-bases on the hub row and PUTs the kept copy", async () => {
      vi.useFakeTimers();
      const annotateRow = { id: "pad-1", updated_at: 500, deleted_at: null };
      const client = fakeClient({
        pingPadSync: vi.fn().mockResolvedValue({ now: 1, annotate: [annotateRow] }),
        getAnnotatePad: vi.fn().mockResolvedValue({
          id: "pad-1",
          name: "book.pdf",
          updated_at: 500,
          footnotes: [],
          source: "hub copy",
        }),
        putAnnotatePad: vi.fn().mockResolvedValue({ id: "pad-1", updated_at: 1234 }),
      });
      const { host, conflicts } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      // The reader keeps Local; resolving also re-bases the device's ack on
      // the row the hub holds — exactly what the Workspace resolver does.
      let ack = 100;
      const acked: number[] = [];
      const hostMutable = host as unknown as {
        pad(): Promise<{
          kind: "annotate";
          id: string;
          hubAckUpdatedAt(): number;
          buildBody(): unknown;
          markHubAck(updatedAt: number): void;
        }>;
        onConflict(c: unknown): Promise<{ pick: "local" }>;
      };
      hostMutable.pad = async () => ({
        kind: "annotate",
        id: "pad-1",
        hubAckUpdatedAt: () => ack,
        buildBody: () => ({
          id: "pad-1",
          name: "book.pdf",
          updated_at: 900,
          source: "local copy",
          // Mirrors annotatePadBody: base names the row this device acked.
          base_updated_at: ack,
        }),
        markHubAck: (updatedAt: number) => {
          acked.push(updatedAt);
          ack = updatedAt;
        },
      });
      hostMutable.onConflict = (conflict) => {
        conflicts.push(conflict);
        ack = 500; // markAnnotateHubAck(id, server.updated_at)
        return Promise.resolve({ pick: "local" });
      };
      const button = await mountWalk(client, host);

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      const putAnnotatePad = (
        client as unknown as { putAnnotatePad: ReturnType<typeof vi.fn> }
      ).putAnnotatePad;
      expect(putAnnotatePad).toHaveBeenCalledTimes(1);
      // The PUT carries the kept local body re-based on the hub's row.
      expect(putAnnotatePad.mock.calls[0]![0]).toBe("pad-1");
      expect((putAnnotatePad.mock.calls[0]![1] as { base_updated_at?: number }).base_updated_at)
        .toBe(500);
      expect(button.dataset.stage).toBe("synced");
      // The row this device just wrote is what it now acknowledges. Without
      // it the next walk sees the hub's copy — its own upload — as newer than
      // the stale ack, and raises a conflict with itself.
      expect(acked).toEqual([1234]);
      expect(ack).toBe(1234);
    });

    it("pings the hub once per walk", async () => {
      // Stage A asked "is the hub up?" and `snapshotHub` asked the same full
      // `pads/sync` question again — the same listing downloaded twice per
      // tap, and two stages of one walk looking at two different worlds.
      vi.useFakeTimers();
      const pingPadSync = vi.fn().mockResolvedValue({ now: 1, annotate: [] });
      const client = fakeClient({
        pingPadSync,
        putAnnotatePad: vi.fn().mockResolvedValue({ id: "pad-1", updated_at: 777 }),
      });
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      (host as unknown as { pad: () => Promise<unknown> }).pad = async () => ({
        kind: "annotate" as const,
        id: "pad-1",
        hubAckUpdatedAt: () => 100,
        buildBody: () => ({ id: "pad-1", name: "book.pdf", updated_at: 900 }),
        markHubAck: () => {},
      });
      const button = await mountWalk(client, host);

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      expect(button.dataset.stage).toBe("synced");
      expect(pingPadSync).toHaveBeenCalledTimes(1);
    });

    it("retries from the stage that failed, not from the top", async () => {
      // `_from` was accepted and ignored, so a failure at Pad re-ran the whole
      // index — on a book, minutes of work to get back to what actually broke.
      vi.useFakeTimers();
      const indexed = {
        hash: "h",
        indexed: true,
        page_count: 7,
        chunk_count: 2,
        embedded: false,
        embed_state: "full",
      };
      const getDocIndex = vi.fn().mockResolvedValue(indexed);
      const putAnnotatePad = vi
        .fn()
        .mockRejectedValueOnce(new Error("hub went away"))
        .mockResolvedValue({ id: "pad-1", updated_at: 777 });
      const client = fakeClient({
        getDocIndex,
        putAnnotatePad,
        pingPadSync: vi.fn().mockResolvedValue({ now: 1, annotate: [] }),
      });
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      (host as unknown as { pad: () => Promise<unknown> }).pad = async () => ({
        kind: "annotate" as const,
        id: "pad-1",
        hubAckUpdatedAt: () => 100,
        buildBody: () => ({ id: "pad-1", name: "book.pdf", updated_at: 900 }),
        markHubAck: () => {},
      });
      const button = await mountWalk(client, host);

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });
      expect(button.dataset.stage).toBe("pad");
      expect(button.dataset.error).toContain("hub went away");
      const indexCallsAfterFirst = getDocIndex.mock.calls.length;
      expect(indexCallsAfterFirst).toBeGreaterThan(0);

      // The retry resumes at Pad; the index stage is not walked again.
      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });
      expect(button.dataset.stage).toBe("synced");
      expect(getDocIndex.mock.calls.length).toBe(indexCallsAfterFirst);
      expect(putAnnotatePad).toHaveBeenCalledTimes(2);
    });

    it("tells the chip the document is indexed", async () => {
      vi.useFakeTimers();
      const client = fakeClient();
      const { host, indexDone } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const button = await mountWalk(client, withPad(host));

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });
      expect(button.dataset.stage).toBe("synced");
      expect(indexDone).toHaveBeenCalled();
    });

    it("stops reading Synced once the pad is edited again", async () => {
      vi.useFakeTimers();
      const client = fakeClient();
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const hostEl = document.createElement("div");
      document.body.append(hostEl);
      const root = createRoot(hostEl);
      const padded = withPad(host);
      const render = (editSeq: number) =>
        act(() =>
          root.render(<HubSyncControl client={client} host={padded} editSeq={editSeq} />),
        );
      render(0);
      const button = hostEl.querySelector(".lc-hub-sync") as HTMLButtonElement;

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });
      expect(button.dataset.stage).toBe("synced");

      // The reader writes something. "Synced" was a claim about a moment that
      // has now passed, and the pill used to keep making it.
      render(1);
      expect(button.dataset.stage).toBe("idle");
      expect(activeLabel(button)).toBe("Sync");
      act(() => root.unmount());
    });

    it("ends a pad-less walk on Sync, not Synced", async () => {
      // A document opened to read has no library row until the first save, so
      // Pad, Ink and Pull have nothing to act on. The walk still indexed, but
      // "Synced" is a claim about a pad row that does not exist.
      vi.useFakeTimers();
      const client = fakeClient();
      const { host, indexDone, walkReports } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const button = await mountWalk(client, host);

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      expect(button.dataset.stage).toBe("idle");
      expect(activeLabel(button)).toBe("Sync");
      expect(button.dataset.error).toBeUndefined();
      // The index half really did happen, and says so.
      expect(indexDone).toHaveBeenCalled();
      // Tab must not land on synced — no pad row, same honesty as the pill.
      expect(walkReports.at(-1)).toBeNull();
      // And the pad stages were skipped rather than run against nothing.
      expect(
        (client as unknown as { putAnnotatePad: ReturnType<typeof vi.fn> }).putAnnotatePad,
      ).not.toHaveBeenCalled();
    });

    it("still syncs links when there is no pad", async () => {
      /*
       * Links are the device's, not this document's: `syncEdges` walks every
       * edge here and every edge the ping reported. Returning early on a
       * pad-less walk would drop the union for every note in the library
       * because the file in front of you happens to be unsaved.
       *
       * Asserted on the calls rather than the labels: the stage attribute is
       * batched away inside `act`, and what matters is which stages ran.
       */
      vi.useFakeTimers();
      vi.resetModules();
      const links = vi.fn().mockResolvedValue(undefined);
      const push = vi.fn();
      vi.doMock("../util/hubWalk", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../util/hubWalk")>()),
        walkSyncLinks: links,
        walkPushPad: push,
      }));
      const { HubSyncControl: Fresh } = await import("./HubSyncControl");

      const client = fakeClient();
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const hostEl = document.createElement("div");
      document.body.append(hostEl);
      const root = createRoot(hostEl);
      act(() => root.render(<Fresh client={client} host={host} />));
      const button = hostEl.querySelector(".lc-hub-sync") as HTMLButtonElement;

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      expect(links).toHaveBeenCalledTimes(1);
      // And the pad-scoped stage was skipped rather than run against nothing.
      expect(push).not.toHaveBeenCalled();
      expect(button.dataset.stage).toBe("idle");

      act(() => root.unmount());
      vi.doUnmock("../util/hubWalk");
      vi.resetModules();
    });

    it("reports every stage it walks, and lands the tab on synced", async () => {
      // The pill morphs its own labels; the tab beside the document had no way
      // to know a walk was running at all, so it read `indexed` throughout.
      vi.useFakeTimers();
      const client = fakeClient();
      const { host, walkReports } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const button = await mountWalk(client, withPad(host));

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      const stages = walkReports.map((r) => r?.stage ?? null);
      expect(stages).toContain("index");
      expect(stages).toContain("pad");
      expect(stages).toContain("ink");
      expect(stages).toContain("links");
      expect(stages).toContain("pull");
      expect(walkReports.at(-1)).toEqual({ stage: "synced", progress: null });
      expect(button.dataset.stage).toBe("synced");
    });

    it("names which half of Index is running", async () => {
      /*
       * Index is one stage holding two jobs that skip independently, so the
       * tab's label has to follow the job. Here the hub has no index, so the
       * extract runs; embedding then reports its own budgets.
       */
      vi.useFakeTimers();
      const client = fakeClient({
        docBytesOnHub: vi.fn().mockResolvedValue(true),
        getDocIndex: vi
          .fn()
          .mockResolvedValueOnce({
            hash: "h",
            indexed: false,
            page_count: 0,
            chunk_count: 0,
            embedded: false,
          })
          .mockResolvedValue({
            hash: "h",
            indexed: true,
            page_count: 3,
            chunk_count: 4,
            chunks_total: 4,
            chunks_embedded: 0,
            embedded: false,
            embed_state: "partial",
          }),
        embedDoc: vi.fn().mockResolvedValue({ done: 4, total: 4 }),
      });
      const { host, walkReports } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const button = await mountWalk(client, withPad(host));

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      const jobs = walkReports
        .filter((r) => r?.stage === "index")
        .map((r) => r?.job ?? null);
      expect(jobs).toContain("embed");
      expect(button.dataset.stage).toBe("synced");
    });

    it("reports the stage it parked on", async () => {
      vi.useFakeTimers();
      const client = fakeClient({
        pingPadSync: vi.fn().mockRejectedValue(new Error("hub unreachable")),
      });
      const { host, walkReports } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const button = await mountWalk(client, withPad(host));

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      const last = walkReports.at(-1) as { stage: string; error?: string } | null;
      expect(last?.stage).toBe("index");
      expect(last?.error).toContain("unreachable");
      expect(button.dataset.stage).toBe("index");
    });

    it("records the hub ack after an ordinary push", async () => {
      vi.useFakeTimers();
      const client = fakeClient({
        pingPadSync: vi.fn().mockResolvedValue({ now: 1, annotate: [] }),
        putAnnotatePad: vi.fn().mockResolvedValue({ id: "pad-1", updated_at: 777 }),
      });
      const { host } = makeHost({
        hash: "h",
        name: "book.pdf",
        docType: "pdf",
        text: "",
        bytes: null,
      });
      const acked: number[] = [];
      let ack = 100;
      (host as unknown as { pad: () => Promise<unknown> }).pad = async () => ({
        kind: "annotate" as const,
        id: "pad-1",
        hubAckUpdatedAt: () => ack,
        buildBody: () => ({ id: "pad-1", name: "book.pdf", updated_at: 900 }),
        markHubAck: (updatedAt: number) => {
          acked.push(updatedAt);
          ack = updatedAt;
        },
      });
      const button = await mountWalk(client, host);

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      expect(button.dataset.stage).toBe("synced");
      expect(acked).toEqual([777]);
    });
  });
});
