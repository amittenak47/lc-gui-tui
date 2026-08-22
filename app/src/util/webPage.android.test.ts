/** @vitest-environment jsdom */
/**
 * The tablet must never reach the capture webview.
 *
 * Not a style preference: on Android wry ignores the rectangle the render view
 * is parked at, so a `new Webview` there opens full-screen over the app, and
 * the close that would clear it is the same unsupported call. The only safe
 * number of times to construct one is zero, so that is what is asserted —
 * that the module is never even imported, rather than that it failed politely.
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

const PAGE = "<html><head><title>Two Sum</title></head><body><p>hello</p></body></html>";

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  captureRenderedPage.mockReset();
  invoke.mockReset();
  invoke.mockResolvedValue({ url: "https://example.com/", html: PAGE });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.resetModules();
});

describe("fetchWebPage on Android", () => {
  it("renders from the fetched copy without constructing a webview", async () => {
    setUserAgent(ANDROID_TABLET);
    const { fetchWebPage } = await import("./webPage");

    const page = await fetchWebPage("https://example.com/", { mode: "page" });

    expect(captureRenderedPage).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("fetch_html", { url: "https://example.com/" });
    expect(page.source).toBe("fetch");
  });

  it("carries no capture error, because nothing was attempted", async () => {
    setUserAgent(ANDROID_TABLET);
    const { fetchWebPage } = await import("./webPage");

    const page = await fetchWebPage("https://example.com/", { mode: "page" });

    expect(page.note).toBeUndefined();
  });

  it("still captures on a desktop user agent", async () => {
    setUserAgent(DESKTOP);
    captureRenderedPage.mockResolvedValue({ url: "https://example.com/", html: PAGE });
    const { fetchWebPage } = await import("./webPage");

    const page = await fetchWebPage("https://example.com/", { mode: "page" });

    expect(captureRenderedPage).toHaveBeenCalledTimes(1);
    expect(page.source).toBe("capture");
  });
});
