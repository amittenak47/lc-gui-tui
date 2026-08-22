/** @vitest-environment jsdom */
/**
 * The guard has to fire before construction, not after.
 *
 * A `new Webview` that cannot be placed is not a view in the wrong spot — on
 * Android it is a full-screen one over the app, and the close that would clear
 * it is the same no-op. So the assertion is on the constructor: it must never
 * run, and `getByLabel` must not be consulted either, since the point is to
 * refuse before touching the webview API at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const constructed = vi.fn();
const getByLabel = vi.fn();

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

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

beforeEach(() => {
  constructed.mockReset();
  getByLabel.mockReset();
  getByLabel.mockResolvedValue(null);
  setUserAgent(ANDROID_TABLET);
});

afterEach(() => {
  vi.resetModules();
});

describe("the capture and live openers on Android", () => {
  it("refuse the offscreen render before constructing anything", async () => {
    const { captureRenderedPage } = await import("./webPageCapture");
    const { resetLabelQueues } = await import("./labelQueue");
    resetLabelQueues();

    await expect(captureRenderedPage("https://example.com/")).rejects.toThrow(
      /needs a desktop webview/,
    );
    expect(constructed).not.toHaveBeenCalled();
    expect(getByLabel).not.toHaveBeenCalled();
  });

  it("refuse the live pane before constructing anything", async () => {
    const { openLiveWebview } = await import("./webPageCapture");
    const { resetLabelQueues } = await import("./labelQueue");
    resetLabelQueues();

    await expect(
      openLiveWebview("https://example.com/", { x: 0, y: 0, width: 10, height: 10 }),
    ).rejects.toThrow(/needs a desktop webview/);
    expect(constructed).not.toHaveBeenCalled();
    expect(getByLabel).not.toHaveBeenCalled();
  });
});
