import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LcClient } from "../api/client";
import { resolveProblemLeave } from "./problemLeave";
import { deleteProblemBoard } from "./problemBoardStore";
import { tabsReducer, HOME_TAB_ID, type TabState } from "./tabs";

vi.mock("./problemBoardStore", () => ({
  problemPadId: (dataset: string, taskId: string) => `${dataset}/${taskId}`,
  deleteProblemBoard: vi.fn(async () => {}),
}));

function setup() {
  const client = {
    putAgentSession: vi.fn(async () => {}),
    finishAttempt: vi.fn(async () => ({ kept_layout: false })),
    tombstoneProblemPad: vi.fn(() => new Promise<never>(() => {})),
  } as unknown as LcClient;
  // Model the shell's closeTab continuation: leave resolves, then it drops the tab.
  let tabs = {
    tabs: [{ id: HOME_TAB_ID, kind: "home", title: "Home" },
      { id: "p", kind: "problem", title: "Problem", dataset: "leetcode", taskId: "two-sum" }],
    activeId: "p",
  } as TabState;
  const run = vi.fn(() => { tabs = tabsReducer(tabs, { type: "close", id: "p" }); });
  return {
    options: { client, dataset: "leetcode", taskId: "two-sum", agent: [{ id: "chat" }],
      solved: true, save: false, localSaves: [] as Promise<unknown>[], dismiss: vi.fn(async () => {}), run },
    tabs: () => tabs,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("resolveLeave's problem work", () => {
  it("closes the tab with a hub tombstone that never resolves", async () => {
    const { options, tabs } = setup();
    await resolveProblemLeave(options);
    expect(tabs().tabs.map(tab => tab.id)).toEqual([HOME_TAB_ID]);
    expect(options.client.tombstoneProblemPad).not.toHaveBeenCalled();
    expect(deleteProblemBoard).toHaveBeenCalledWith("leetcode/two-sum");
    expect(vi.mocked(deleteProblemBoard).mock.invocationCallOrder[0]).toBeLessThan(options.run.mock.invocationCallOrder[0]);
  });

  it("keeps the tab and propagates a local finish failure to the dialog", async () => {
    const { options, tabs } = setup();
    vi.mocked(options.client.finishAttempt).mockRejectedValueOnce(new Error("local disk full"));
    await expect(resolveProblemLeave(options)).rejects.toThrow("local disk full");
    expect(tabs().activeId).toBe("p");
    expect(options.dismiss).not.toHaveBeenCalled();
    expect(options.client.tombstoneProblemPad).not.toHaveBeenCalled();
  });

  it("waits for only the local part of a pending autosave before clearing", async () => {
    const { options } = setup();
    let release!: () => void;
    options.localSaves = [new Promise<void>(resolve => { release = resolve; })];
    const leave = resolveProblemLeave(options);
    await Promise.resolve();
    await Promise.resolve();
    expect(options.client.finishAttempt).not.toHaveBeenCalled();
    release();
    await leave;
    expect(options.run).toHaveBeenCalledOnce();
  });

  it("keeps the local board and tab when its durable deletion intent cannot be saved", async () => {
    const { options, tabs } = setup();
    vi.mocked(deleteProblemBoard).mockRejectedValueOnce(new Error("pending sync could not be saved"));
    await expect(resolveProblemLeave(options)).rejects.toThrow("pending sync could not be saved");
    expect(deleteProblemBoard).toHaveBeenCalledWith("leetcode/two-sum");
    expect(options.dismiss).not.toHaveBeenCalled();
    expect(tabs().activeId).toBe("p");
  });

  it("keeps saved layouts without creating a tombstone", async () => {
    const { options } = setup();
    vi.mocked(options.client.finishAttempt).mockResolvedValueOnce({ kept_layout: true } as Awaited<ReturnType<LcClient["finishAttempt"]>>);
    await resolveProblemLeave({ ...options, save: true });
    expect(deleteProblemBoard).not.toHaveBeenCalled();
    expect(options.run).toHaveBeenCalledOnce();
  });
});
