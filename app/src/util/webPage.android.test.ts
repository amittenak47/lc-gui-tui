/** @vitest-environment jsdom */
/**
 * What a tablet does with an address.
 *
 * This file used to assert that Android never reached the capture path at all
 * — the only safe number of wry child webviews there being zero, since one
 * opens full-screen over the app and cannot be closed. That is still true of
 * *wry*, and `webPageCapture.transport.test.ts` is where it is now asserted.
 *
 * It stays true here for a different reason, and the reason is speed. The
 * offscreen render *can* run on Android now — the plugin serves it — and for a
 * short while it did. Every step of it is a poll across the JS/Rust/JNI bridge,
 * so opening a page in reader or frozen mode went from under a second to thirty
 * and worse. Fidelity lives in Live and in Freeze, which reads the view already
 * on screen; this path is the cheap GET on anything but desktop, and it is what
 * makes opening a page feel instant.
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
  it("opens from the fetched copy without spinning a second render", async () => {
    // The regression this pins: a render here is ~30s of bridge polling on a
    // tablet, for a page Live already shows in under one.
    setUserAgent(ANDROID_TABLET);
    captureRenderedPage.mockResolvedValue({ url: "https://example.com/", html: RENDERED });
    const { fetchWebPage } = await import("./webPage");

    const page = await fetchWebPage("https://example.com/", { mode: "page" });

    expect(captureRenderedPage).not.toHaveBeenCalled();
    expect(page.source).toBe("fetch");
    expect(page.note).toBeUndefined();
  });

  it("carries no error note, because nothing was attempted", async () => {
    // Not a failure that fell back — a path that was never taken. The reader
    // gets a page and no banner explaining a render they did not ask for.
    setUserAgent(ANDROID_TABLET);
    captureRenderedPage.mockRejectedValue(new Error("should never be called"));
    const { fetchWebPage } = await import("./webPage");

    const page = await fetchWebPage("https://example.com/", { mode: "page" });

    expect(page.source).toBe("fetch");
    expect(page.note).toBeUndefined();
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
