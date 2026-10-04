/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PadHub } from "../util/padHub";
import { DocIndexChip } from "./DocIndexChip";
import { HubLibraryRefresh } from "./HubLibraryRefresh";
import { HubStatusDot } from "./HubStatusDot";

const shared = vi.hoisted(() => ({
  hub: { url: "http://desktop:7878", token: "token" } as PadHub | null,
  status: "online" as "online" | "offline" | "unknown",
}));
vi.mock("../util/padHubStatus", () => ({ usePadHubStatus: () => shared }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  shared.hub = { url: "http://desktop:7878", token: "token" };
  shared.status = "online";
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("desktop hub status dot", () => {
  it.each(["online", "offline"] as const)("identifies an %s hub accessibly", (status) => {
    shared.status = status;
    act(() => root.render(<HubStatusDot />));
    const dot = host.querySelector(".lc-agent-live-dot");
    expect(dot?.getAttribute("data-status")).toBe(status);
    expect(dot?.getAttribute("aria-label")).toBe(`Desktop hub ${status}`);
    expect(dot?.getAttribute("title")).toBe(`Desktop hub ${status}`);
    expect(dot?.getAttribute("role")).toBe("img");
  });

  it("hides the dot when no hub is configured", () => {
    shared.hub = null;
    act(() => root.render(<HubStatusDot />));
    expect(host.childElementCount).toBe(0);
  });

  it("waits for a known status before claiming reachability", () => {
    shared.status = "unknown";
    act(() => root.render(<HubStatusDot />));
    expect(host.childElementCount).toBe(0);
  });

  it("keeps hub availability distinct from the pad's acknowledged sync state", () => {
    shared.status = "offline";
    act(() => root.render(<>
      <DocIndexChip status="idle" meta={null} error={null} padSync="synced" onSync={() => {}} />
      <HubLibraryRefresh onRefresh={async () => 0} />
    </>));
    expect(host.querySelector(".lc-doc-index-chip")?.textContent).toBe("synced");
    for (const selector of [".lc-doc-index-chip", ".lc-doc-index-sync", ".lc-hub-pull-command"]) {
      expect(host.querySelector(`${selector} [aria-label="Desktop hub offline"]`)).not.toBeNull();
    }
    shared.hub = null;
    act(() => root.render(<>
      <DocIndexChip status="idle" meta={null} error={null} padSync="synced" onSync={() => {}} />
      <HubLibraryRefresh onRefresh={async () => 0} />
    </>));
    expect(host.querySelector(".lc-hub-status-dot")).toBeNull();
  });
});
