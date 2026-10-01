/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DOC_PARSE_INLINE_MAX_CHARS } from "./docPreview";

const cache = vi.hoisted(() => ({
  load: vi.fn(),
  store: vi.fn(),
  loadLayout: vi.fn(),
  storeLayout: vi.fn(),
  dropLayout: vi.fn(),
}));
vi.mock("./markdownHtmlCache", () => ({
  MD_HTML_CACHE_MIN_CHARS: 20_000,
  loadMarkdownHtml: cache.load,
  storeMarkdownHtml: cache.store,
  loadMarkdownLayout: cache.loadLayout,
  storeMarkdownLayout: cache.storeLayout,
  dropMarkdownLayout: cache.dropLayout,
  markdownLayoutKey: (source: string, shape: string) => `${source.length}|${shape}`,
}));

import { AnnotateDocument, applySkippableHeights } from "./AnnotateDocument";

/** Long enough to take the off-render path a relaunch takes. */
const LONG = `# Notes\n\n${"A sentence about graphs. ".repeat(Math.ceil(DOC_PARSE_INLINE_MAX_CHARS / 20))}`;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  cache.load.mockReset();
  cache.store.mockReset().mockResolvedValue(undefined);
  cache.loadLayout.mockReset().mockResolvedValue(null);
  cache.storeLayout.mockReset().mockResolvedValue(undefined);
  cache.dropLayout.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); document.body.textContent = ""; });

async function open(source: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AnnotateDocument source={source} />));
  // The cache answers, then a frame for a render on a miss.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  return { host, unmount: () => act(async () => root.unmount()) };
}

it("shows the last render of the same text without rendering it again", async () => {
  cache.load.mockResolvedValue("<h1>From the cache</h1>");
  const { host, unmount } = await open(LONG);
  expect(host.querySelector("h1")!.textContent).toBe("From the cache");
  expect(cache.store).not.toHaveBeenCalled();
  await unmount();
});

it("renders on a miss and keeps the result for the next open", async () => {
  cache.load.mockResolvedValue(null);
  const { host, unmount } = await open(LONG);
  expect(host.querySelector("h1")!.textContent).toBe("Notes");
  expect(cache.store).toHaveBeenCalledOnce();
  expect(cache.store.mock.calls[0]![0]).toBe(LONG);
  expect(cache.store.mock.calls[0]![1]).toContain("<h1");
  await unmount();
});

it("never asks the cache about a short note, which renders inline", async () => {
  const { host, unmount } = await open("# Short\n\nOne line.");
  expect(host.querySelector("h1")!.textContent).toBe("Short");
  expect(cache.load).not.toHaveBeenCalled();
  await unmount();
});

it("lets recorded paragraphs and headings skip layout, and nothing else", async () => {
  cache.load.mockResolvedValue("<h2>Title</h2><p>Prose.</p><ul><li><p>Item</p></li></ul><pre>code</pre><p>More.</p>");
  cache.loadLayout.mockResolvedValue({ heights: [30, 48, 60, 40, 24], storedAt: 0 });
  const { host, unmount } = await open(LONG);
  const doc = host.querySelector(".lc-md-ink-doc")!;
  const [h2, p, ul, pre, last] = Array.from(doc.children) as HTMLElement[];
  expect(h2!.style.contentVisibility).toBe("auto");
  expect(h2!.style.containIntrinsicSize).toBe("30px");
  expect(p!.style.containIntrinsicSize).toBe("48px");
  // A list's margins could collapse differently; a fence is a scroll host.
  expect(ul!.style.contentVisibility).toBe("");
  expect(pre!.style.contentVisibility).toBe("");
  expect(last!.style.containIntrinsicSize).toBe("24px");
  await unmount();
});

it("ignores a record taken from a different render", () => {
  const doc = document.createElement("div");
  doc.innerHTML = "<p>One</p><p>Two</p>";
  expect(applySkippableHeights(doc, { heights: [10], storedAt: 0 })).toBe(false);
  expect((doc.firstElementChild as HTMLElement).style.contentVisibility).toBe("");
});

it("drops the record when a block renders at another size", async () => {
  cache.load.mockResolvedValue("<p>Prose.</p><p>More.</p>");
  cache.loadLayout.mockResolvedValue({ heights: [48, 24], storedAt: 0 });
  const { host, unmount } = await open(LONG);
  const doc = host.querySelector(".lc-md-ink-doc")!;
  const first = doc.firstElementChild as HTMLElement;
  // jsdom lays nothing out: the block is "really" 0 tall, not the 48 recorded.
  const shown = Object.assign(new Event("contentvisibilityautostatechange"), { skipped: false });
  await act(async () => { first.dispatchEvent(shown); });
  expect(cache.dropLayout).toHaveBeenCalledOnce();
  await unmount();
});
