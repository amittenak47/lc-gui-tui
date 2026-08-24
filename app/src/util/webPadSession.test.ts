import { describe, expect, it } from "vitest";

import { canStepWeb, currentEntry, needsFetch, pushWeb, stepWeb } from "./webPadSession";

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

  it("in-place show target is the pushed page, not the old snapshot", () => {
    const tab = { id: "w1", kind: "web" as const, ...history(home) };
    const wiki = {
      url: "https://en.wikipedia.org/wiki/Single_source_of_truth",
      title: "Single source of truth",
      html: "<p>article</p>",
    };
    const nextTab = pushWeb(tab, wiki);
    expect(currentEntry(tab)?.url).toBe(home.url);
    expect(currentEntry(nextTab)?.url).toBe(wiki.url);
    expect(currentEntry(nextTab)?.html).toBe(wiki.html);
  });
});

/**
 * Live browsing records a place; frozen browsing records a page.
 *
 * They share one history on purpose — the mode is a rendering of the page you
 * are on, not a separate session, so Back has to mean one thing and switching
 * live/frozen has to keep your place. The cost of sharing is that some entries
 * arrive without their HTML, and these pin what that must not break.
 */
describe("entries recorded from live browsing", () => {
  const live = (url: string) => ({ url, title: url });
  const frozen = (url: string, html: string) => ({ url, title: url, html });

  it("is a place that has to be fetched before it can be shown", () => {
    expect(needsFetch(live("https://a.test/"))).toBe(true);
    expect(needsFetch(frozen("https://a.test/", "<p>a</p>"))).toBe(false);
    expect(needsFetch(undefined)).toBe(false);
  });

  it("still steps like any other entry", () => {
    let tab = { entries: [], index: -1 } as { entries: ReturnType<typeof live>[]; index: number };
    tab = pushWeb(tab, live("https://a.test/"));
    tab = pushWeb(tab, live("https://b.test/"));

    expect(canStepWeb(tab, -1)).toBe(true);
    expect(currentEntry(stepWeb(tab, -1))?.url).toBe("https://a.test/");
  });

  it("is replaced by the snapshot when one arrives, not joined by it", () => {
    // Otherwise Back walks the same address twice — once as a promise and once
    // as the thing itself — which is the history growing every time you step.
    let tab = { entries: [], index: -1 } as { entries: ReturnType<typeof frozen>[]; index: number };
    tab = pushWeb(tab, live("https://a.test/"));
    tab = pushWeb(tab, frozen("https://a.test/", "<p>a</p>"));

    expect(tab.entries).toHaveLength(1);
    expect(currentEntry(tab)?.html).toBe("<p>a</p>");
    expect(needsFetch(currentEntry(tab))).toBe(false);
  });

  it("does not swallow a different address that follows it", () => {
    let tab = { entries: [], index: -1 } as { entries: ReturnType<typeof frozen>[]; index: number };
    tab = pushWeb(tab, live("https://a.test/"));
    tab = pushWeb(tab, frozen("https://b.test/", "<p>b</p>"));

    expect(tab.entries.map((e) => e.url)).toEqual(["https://a.test/", "https://b.test/"]);
  });
});
