/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";

import { brief, pendingDebugEntriesForTests, setDebugLogEnabled, wrapForDebug } from "./debugLog";

afterEach(() => setDebugLogEnabled(false));

it("keeps every value short and never throws on one", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  expect(brief(cyclic)).toContain("[circular]");
  expect(brief("x".repeat(1000)).length).toBeLessThan(330);
  expect(brief(new ArrayBuffer(16))).toBe("[ArrayBuffer 16]");
  expect(brief(Array.from({ length: 40 }, (_, i) => i))).toContain("…+28");
  expect(brief(new Error("boom"))).toBe("Error: boom");
});

it("hands an object back untouched while the log is off", () => {
  const target = { ping: () => "pong" };
  expect(wrapForDebug("t", target)).toBe(target);
});

it("records calls, their results and their failures while on", async () => {
  setDebugLogEnabled(true);
  const target = {
    add: (a: number, b: number) => a + b,
    later: async () => "done",
    fail: () => { throw new Error("nope"); },
    getViewportBounds: () => ({ x: 0 }),
  };
  const wrapped = wrapForDebug("t", target);
  expect(wrapped.add(2, 3)).toBe(5);
  expect(await wrapped.later()).toBe("done");
  expect(() => wrapped.fail()).toThrow("nope");
  wrapped.getViewportBounds();
  const calls = pendingDebugEntriesForTests().filter((e) => e.k === "call");
  expect(calls.map((e) => e.n)).toEqual(["t.add", "t.later", "t.fail"]);
  expect(calls[0]).toMatchObject({ a: "[2,3]", r: "5" });
  expect(calls[2]!.e).toBe("Error: nope");
});

it("records taps by label and keys by name only", () => {
  setDebugLogEnabled(true);
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Open settings");
  document.body.append(button);
  button.click();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "q" }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  const names = pendingDebugEntriesForTests().filter((e) => e.k === "action").map((e) => e.n);
  expect(names).toContain("click Open settings");
  expect(names).toContain("key char");
  expect(names).toContain("key ArrowRight");
  expect(names.join(" ")).not.toContain("q");
  button.remove();
});
