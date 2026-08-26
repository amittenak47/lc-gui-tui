/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { HubSyncControl, type HubSyncWalkHost } from "./HubSyncControl";
import type { LcClient } from "../api/client";

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
      };
      return fns as unknown as LcClient & Record<string, ReturnType<typeof vi.fn>>;
    }

    function makeHost(doc: HubSyncWalkHost["doc"] extends () => infer R ? R : never) {
      const progress = vi.fn();
      const errors = vi.fn();
      const host: HubSyncWalkHost = {
        doc: () => doc,
        onIndexProgress: (p) => progress(p),
        onIndexError: (m) => errors(m),
      };
      return { host, progress, errors };
    }

    async function mountWalk(client: LcClient, host: HubSyncWalkHost) {
      const hostEl = document.createElement("div");
      document.body.append(hostEl);
      const root = createRoot(hostEl);
      act(() => root.render(<HubSyncControl client={client} host={host} />));
      return hostEl.querySelector(".lc-hub-sync") as HTMLButtonElement;
    }

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
  });
});
