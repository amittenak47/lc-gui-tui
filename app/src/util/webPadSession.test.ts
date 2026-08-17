import { describe, expect, it } from "vitest";

import { canStepWeb, currentEntry, pushWeb, stepWeb } from "./webPadSession";

const home = { url: "https://www.google.com/", title: "Google", html: "<p>home</p>" };
const next = { url: "https://www.google.com/imghp", title: "Images", html: "<p>img</p>" };

const history = (...entries: typeof home[]) => ({ entries, index: entries.length - 1 });

describe("webPadSession", () => {
  it("pushes and drops the forward stack", () => {
    const tab = pushWeb(history(home), next);
    expect(currentEntry(tab)?.url).toBe(next.url);
    expect(canStepWeb(tab, -1)).toBe(true);
    const back = stepWeb(tab, -1);
    expect(currentEntry(back)?.url).toBe(home.url);
    const branched = pushWeb(back, { url: "https://a.test/", title: "A", html: "<p>a</p>" });
    expect(branched.entries).toHaveLength(2);
    expect(canStepWeb(branched, 1)).toBe(false);
  });

  it("replaces the top entry rather than repeating it", () => {
    const tab = pushWeb(history(home), { ...home });
    expect(tab.entries).toHaveLength(1);
    expect(tab.index).toBe(0);
  });

  it("carries the fields of whatever record owns the history", () => {
    // A tab record *is* its history, so stepping must not strip its identity.
    const tab = { id: "w1", kind: "web" as const, ...history(home, next) };
    expect(stepWeb(tab, -1)).toMatchObject({ id: "w1", kind: "web", index: 0 });
    expect(pushWeb(tab, { url: "https://a.test/", title: "A", html: "<p>a</p>" }).id).toBe("w1");
  });
});
