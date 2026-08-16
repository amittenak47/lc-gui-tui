import { describe, expect, it } from "vitest";

import {
  canStepWeb,
  closeWebTab,
  commitWebPush,
  currentEntry,
  pushWeb,
  stepWeb,
  tabFromEntry,
} from "./webPadSession";

const home = { url: "https://www.google.com/", title: "Google", html: "<p>home</p>" };
const next = { url: "https://www.google.com/imghp", title: "Images", html: "<p>img</p>" };

describe("webPadSession", () => {
  it("pushes and drops the forward stack", () => {
    const tab = pushWeb(tabFromEntry(home), next);
    expect(currentEntry(tab)?.url).toBe(next.url);
    expect(canStepWeb(tab, -1)).toBe(true);
    const back = stepWeb(tab, -1);
    expect(currentEntry(back)?.url).toBe(home.url);
    const branched = pushWeb(back, { url: "https://a.test/", title: "A", html: "<p>a</p>" });
    expect(branched.entries).toHaveLength(2);
    expect(canStepWeb(branched, 1)).toBe(false);
  });

  it("opens a new tab instead of replacing the current one", () => {
    const first = tabFromEntry(home);
    const pushed = commitWebPush([first], first.id, next);
    expect(pushed.tabs).toHaveLength(1);
    expect(currentEntry(pushed.tabs[0]!)?.url).toBe(next.url);
    const extra = commitWebPush(pushed.tabs, pushed.tabId, home, true);
    expect(extra.tabs).toHaveLength(2);
    expect(currentEntry(extra.tabs[1]!)?.url).toBe(home.url);
  });

  it("closes a tab onto its neighbor", () => {
    const a = tabFromEntry(home);
    const b = tabFromEntry(next);
    const closed = closeWebTab([a, b], a.id);
    expect(closed.tabs).toHaveLength(1);
    expect(closed.tabId).toBe(b.id);
    expect(closeWebTab([b], b.id).tabId).toBeNull();
  });
});
