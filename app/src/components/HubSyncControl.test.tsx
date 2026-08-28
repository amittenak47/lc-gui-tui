/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { HubSyncControl, type HubSyncWalkHost } from "./HubSyncControl";
import type { LcClient } from "../api/client";
import { PAD_HUB_KEY } from "../util/padHub";

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

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.dataset.stage).toBe("idle");
    expect(activeLabel(button)).toBe("Sync");
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
        listAnnotatePads: overrides.listAnnotatePads ?? vi.fn().mockResolvedValue([]),
        listWhiteboardPads: overrides.listWhiteboardPads ?? vi.fn().mockResolvedValue([]),
        putAnnotatePad: overrides.putAnnotatePad ?? vi.fn(),
        putWhiteboardPad: overrides.putWhiteboardPad ?? vi.fn(),
      };
      return fns as unknown as LcClient & Record<string, ReturnType<typeof vi.fn>>;
    }

    function makeHost(doc: HubSyncWalkHost["doc"] extends () => infer R ? R : never) {
      const progress = vi.fn();
      const errors = vi.fn();
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
        onIndexError: (m) => errors(m),
      };
      return { host, progress, errors, reload, conflicts, picks };
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
      const button = await mountWalk(client, host);

      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.runAllTimersAsync();
      });

      expect((client as unknown as typeof client & { indexFromBytes: ReturnType<typeof vi.fn> }).indexFromBytes)
        .toHaveBeenCalledWith("h", { name: "book.pdf", doc_type: "pdf", source_text: undefined });
      expect(button.dataset.stage).toBe("synced");
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
      const button = await mountWalk(client, host);

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
      const button = await mountWalk(client, host);

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
        listAnnotatePads: vi.fn().mockResolvedValue([
          { id: "pad-1", name: "book.pdf", updated_at: 500, footnotes: [], source: "hub copy" },
        ]),
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
        listAnnotatePads: vi.fn().mockResolvedValue([
          { id: "pad-1", name: "book.pdf", updated_at: 500, footnotes: [], source: "hub copy" },
        ]),
        putAnnotatePad: vi.fn().mockResolvedValue({ id: "pad-1", updated_at: Date.now() }),
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
      const hostMutable = host as unknown as {
        pad(): Promise<{
          kind: "annotate";
          id: string;
          hubAckUpdatedAt(): number;
          buildBody(): unknown;
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
    });
  });
});
