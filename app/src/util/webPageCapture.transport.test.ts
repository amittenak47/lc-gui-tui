/** @vitest-environment jsdom */
/**
 * The tablet must never reach wry's child webview — and must still get a page.
 *
 * Both halves matter and they used to be one. A `new Webview` that cannot be
 * placed is not a view in the wrong spot: on Android it is a full-screen one
 * over the app, and the close that would clear it is the same no-op. So the
 * constructor is still asserted on, and `getByLabel` with it, because the point
 * is to refuse before touching the wry API at all.
 *
 * What is new is where the refusal leads. It used to be a rejection and a
 * fallback to the fetched copy; now it is the `livewebview` plugin, so the
 * assertions are that the commands went out — create, place, show, close — with
 * the rectangle the pane measured and the density the page is drawn at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const constructed = vi.fn();
const getByLabel = vi.fn();
const invoke = vi.fn();

vi.mock("@tauri-apps/api/webview", () => {
  class Webview {
    constructor(...args: unknown[]) {
      constructed(...args);
    }
    static getByLabel = getByLabel;
  }
  return { Webview };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalPosition: class {},
  LogicalSize: class {},
}));
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

function leaveShell(): void {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

/** Every command the plugin bridge sent, in order. */
function commands(): string[] {
  return invoke.mock.calls.map((call) => String(call[0]));
}

function argsOf(cmd: string): Record<string, unknown> | undefined {
  const call = invoke.mock.calls.find((entry) => entry[0] === cmd);
  return call?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  constructed.mockReset();
  getByLabel.mockReset();
  getByLabel.mockResolvedValue(null);
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  setUserAgent(ANDROID_TABLET);
  enterShell();
  Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
});

afterEach(() => {
  leaveShell();
  vi.resetModules();
});

describe("the live pane on Android", () => {
  it("opens through the plugin, never through wry", async () => {
    const { openLiveWebview } = await import("./webPageCapture");
    const { resetLabelQueues } = await import("./labelQueue");
    resetLabelQueues();

    await openLiveWebview("https://example.com/", { x: 12, y: 40, width: 800, height: 600 });

    expect(constructed).not.toHaveBeenCalled();
    expect(getByLabel).not.toHaveBeenCalled();
    // Closed by label first, exactly as the wry path does: one view per name.
    expect(commands()).toEqual(["live_webview_close", "live_webview_create"]);
    expect(argsOf("live_webview_create")).toMatchObject({
      label: "lc-web-live",
      url: "https://example.com/",
      rect: { x: 12, y: 40, width: 800, height: 600 },
      behind: false,
    });
  });

  it("sends the rectangle in CSS pixels and the scale beside it", async () => {
    // The conversion belongs to Kotlin, which also knows the view's screen
    // origin. Doing it here would mean the layout code knew about device px.
    const { placeLiveWebview } = await import("./webPageCapture");

    await placeLiveWebview({ x: 10.4, y: 20.6, width: 300.2, height: 0 });

    expect(argsOf("live_webview_place")).toEqual({
      label: "lc-web-live",
      rect: { x: 10, y: 21, width: 300, height: 1 },
      density: 2,
    });
  });

  it("parks the view rather than closing it", async () => {
    const { showLiveWebview } = await import("./webPageCapture");

    await showLiveWebview(false);

    expect(argsOf("live_webview_show")).toEqual({ label: "lc-web-live", visible: false });
    expect(constructed).not.toHaveBeenCalled();
  });
});

describe("freezing a live page on Android", () => {
  it("asks whether there is one through the plugin, not through wry", async () => {
    // `liveWebview()` was the old way to ask, and it answers null on Android
    // whether or not a page is up. Freeze would then report "the live page has
    // closed" at a reader looking straight at it.
    const { serializeLiveWebview } = await import("./webPageCapture");
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "live_webview_exists") return Promise.resolve(true);
      if (cmd === "webview_eval_json") return Promise.reject(new Error("no page here"));
      return Promise.resolve(undefined);
    });

    // Rejects on the eval, which is as far as a test without a page can go —
    // the point is that it got past the existence check at all.
    await expect(serializeLiveWebview()).rejects.toThrow(/no page here/);
    expect(getByLabel).not.toHaveBeenCalled();
    expect(argsOf("live_webview_exists")).toEqual({ label: "lc-web-live" });
  });

  it("says the page has closed when the plugin has no view", async () => {
    const { serializeLiveWebview } = await import("./webPageCapture");
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "live_webview_exists") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });

    await expect(serializeLiveWebview()).rejects.toThrow(/the live page has closed/);
    expect(commands()).not.toContain("webview_eval_json");
  });
});

describe("the offscreen render on Android", () => {
  it("goes behind the app instead of past the edge of it", async () => {
    // `y: 10_000` is the instruction Android ignores, which is how a capture
    // ended up covering the app. `behind` is the same invisibility, honestly.
    const { captureRenderedPage } = await import("./webPageCapture");
    const { resetLabelQueues } = await import("./labelQueue");
    resetLabelQueues();
    invoke.mockImplementation((cmd: string) => {
      // No page behind the bridge in a test, so the first read fails fast.
      if (cmd === "webview_eval_json") return Promise.reject(new Error("no page here"));
      return Promise.resolve(undefined);
    });

    // Which means this rejects — the assertion is about the view that was
    // opened and taken away again, not the page that never came back.
    await captureRenderedPage("https://example.com/", { width: 900, height: 700 }).catch(
      () => undefined,
    );

    expect(constructed).not.toHaveBeenCalled();
    expect(argsOf("live_webview_create")).toMatchObject({
      label: "lc-web-capture",
      rect: { x: 0, y: 0, width: 900, height: 700 },
      behind: true,
    });
    expect(commands()).toContain("live_webview_close");
  });
});

describe("a plain browser tab", () => {
  it("refuses before constructing anything", async () => {
    leaveShell();
    setUserAgent(DESKTOP);
    const { captureRenderedPage, openLiveWebview } = await import("./webPageCapture");
    const { resetLabelQueues } = await import("./labelQueue");
    resetLabelQueues();

    await expect(captureRenderedPage("https://example.com/")).rejects.toThrow(/Tauri shell/);
    await expect(
      openLiveWebview("https://example.com/", { x: 0, y: 0, width: 10, height: 10 }),
    ).rejects.toThrow(/Tauri shell/);
    expect(constructed).not.toHaveBeenCalled();
    expect(getByLabel).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
