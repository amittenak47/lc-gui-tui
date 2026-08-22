/** @vitest-environment jsdom */
/**
 * What a tablet does with an address.
 *
 * This file used to assert that Android never reached the capture path at all
 * — the only safe number of wry child webviews there being zero, since one
 * opens full-screen over the app and cannot be closed. That is still true of
 * *wry*, and `webPageCapture.transport.test.ts` is where it is now asserted.
 *
 * The question here is one level up and it has changed its answer. `fetchWebPage`
 * gates on whether a live surface exists, not on which platform this is, so on
 * a tablet in the app shell the render now runs — through the `livewebview`
 * plugin — and the reader gets the page rather than a copy of its markup. In a
 * browser tab, with no shell to ask, the cheap GET is still the whole story.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const captureRenderedPage = vi.fn();

vi.mock("./webPageCapture", () => ({
  captureRenderedPage,
  liveWebviewSupported: () => {
    throw new Error("the capture module must not be loaded to answer this");
  },
}));

/*
 * `webPage.ts` keeps its own `isTauriRuntime`/`loadInvoke` rather than importing
 * them, so the runtime is faked the way the module actually reads it: the
 * `__TAURI_INTERNALS__` marker on `window`, and the real `core` module mocked.
 */
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

function enterShell(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

const PAGE = "<html><head><title>Two Sum</title></head><body><p>hello</p></body></html>";
const RENDERED =
  "<html><head><title>Two Sum</title></head><body><p>hello, after the script ran</p></body></html>";

beforeEach(() => {
  enterShell();
  captureRenderedPage.mockReset();
  invoke.mockReset();
  invoke.mockResolvedValue({ url: "https://example.com/", html: PAGE });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("fetchWebPage on an Android tablet", () => {
  it("renders the page, the same as a desktop does", async () => {
    setUserAgent(ANDROID_TABLET);
    captureRenderedPage.mockResolvedValue({ url: "https://example.com/", html: RENDERED });
    const { fetchWebPage } = await import("./webPage");

    const page = await fetchWebPage("https://example.com/", { mode: "page" });

    expect(captureRenderedPage).toHaveBeenCalledTimes(1);
    expect(page.source).toBe("capture");
    expect(page.note).toBeUndefined();
  });

  it("falls back to the fetched copy when the render fails, and says so", async () => {
    // The plugin can still be missing from an old APK. That is a sentence in
    // the banner and a page that reads, not a page that never opens.
    setUserAgent(ANDROID_TABLET);
    captureRenderedPage.mockRejectedValue(new Error("live web view unavailable"));
    const { fetchWebPage } = await import("./webPage");

    const page = await fetchWebPage("https://example.com/", { mode: "page" });

    expect(page.source).toBe("fetch");
    expect(page.note).toMatch(/live web view unavailable/);
  });
});

describe("fetchWebPage in a browser tab", () => {
  it("never loads the capture module, on Android or anywhere else", async () => {
    // No shell means no native surface under any name, so there is nothing to
    // ask — asserted as "the module was never imported" rather than "it
    // refused politely", because importing it is the part that costs.
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    setUserAgent(ANDROID_TABLET);
    // No shell also means no `fetch_html` command: `npm run dev` reaches pages
    // through the Vite proxy instead, which is a plain `fetch`.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        text: () => Promise.resolve(PAGE),
      }),
    );
    const { fetchWebPage } = await import("./webPage");

    const page = await fetchWebPage("https://example.com/", { mode: "page" });

    expect(captureRenderedPage).not.toHaveBeenCalled();
    expect(page.source).toBe("fetch");
  });
});

describe("fetchWebPage on the desktop shell", () => {
  it("still captures", async () => {
    setUserAgent(DESKTOP);
    captureRenderedPage.mockResolvedValue({ url: "https://example.com/", html: PAGE });
    const { fetchWebPage } = await import("./webPage");

    const page = await fetchWebPage("https://example.com/", { mode: "page" });

    expect(captureRenderedPage).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("fetch_html", { url: "https://example.com/" });
    expect(page.source).toBe("capture");
  });
});
