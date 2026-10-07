/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { HubConflictSplit } from "../components/HubConflictSplit";
import type { HubConflictResolution, HubPadConflict } from "./hubConflictStash";
import { conflictUiSession } from "./conflictUiSession";
import { waitForConflictUi } from "./conflictUiWait";

afterEach(() => vi.unstubAllGlobals());

const record = { id: "disposable", name: "Fixture", hash: "h", doc_type: "markdown" as const,
  source: "Fixture", updated_at: 1, board: { v: 1, elements: [], appState: {} }, agent: [], footnotes: [] };
const conflict: HubPadConflict = { modernChoice: true, kind: "annotate", id: record.id, stage: "pad", detail: "changed",
  local: { ...record, source: "Local" }, server: { ...record, source: "Hub" } };

it("delivers Keep through an async adapter when the real split unmounts before its promise resumes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let choose!: (choice: HubConflictResolution) => void;
  const unavailable = vi.fn();
  let waiting!: Promise<HubConflictResolution>;
  act(() => { waiting = waitForConflictUi(async lifecycle => {
    const session = conflictUiSession({ ...lifecycle, onUnavailable: () => { unavailable(); lifecycle.onUnavailable(); } });
    const decision = await new Promise<HubConflictResolution>(resolve => {
      choose = value => {
        session.complete();
        root.render(null); // React may run layout cleanup before the adapter resumes.
        resolve(value);
      };
      root.render(<HubConflictSplit conflict={conflict} onMounted={session.onMounted}
        onUnavailable={session.onUnavailable} onResolve={choose} />);
    });
    await Promise.resolve(); // askBookConflict also resumes and prepares the DTO.
    return decision;
  }, new AbortController().signal, "couldn't open the merge window"); });
  const outcome = waiting.then(value => ({ value }), error => ({ error }));
  try {
    await act(async () => {});
    act(() => choose({ pick: "local", ink: "local" }));
    expect(await outcome).toEqual({ value: { pick: "local", ink: "local" } });
    expect(unavailable).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); host.remove(); }
});

it("still rejects a mounted split that disappears without a choice", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let waiting!: Promise<unknown>;
  act(() => { waiting = waitForConflictUi(lifecycle => {
    const session = conflictUiSession(lifecycle);
    root.render(<HubConflictSplit conflict={conflict} onMounted={session.onMounted}
      onUnavailable={session.onUnavailable} onResolve={() => {}} />);
    return new Promise(() => {});
  }, new AbortController().signal, "window disappeared"); });
  const outcome = expect(waiting).rejects.toThrow("window disappeared");
  try { await act(async () => {}); act(() => root.render(null)); await outcome; }
  finally { act(() => root.unmount()); host.remove(); }
});
