/**
 * The real browser, borrowed.
 *
 * A child web view that loads a page for real — its JavaScript runs, its CSS
 * applies, its fonts load. Two things are done with it:
 *
 * - **Live**: shown over the pane, so the reader can actually browse. This is
 *   the only way a page ever looks like itself; a serialised DOM is a
 *   reconstruction and always will be.
 * - **Frozen**: serialised into HTML the pad can paint under ink. That is what
 *   makes a page annotatable, and it costs the fidelity above — which is why
 *   browsing and annotating are two states rather than one.
 *
 * The view paints above all HTML, so nothing of ours can be drawn over it
 * while it is live.
 *
 * **Two transports, one shape.** On desktop the view is wry's, driven through
 * the JS `Webview` API. On Android wry has no child webview at all — it maps
 * `new_as_child` onto `new` and its `set_bounds`/`set_visible` do nothing — so
 * the view is an `android.webkit.WebView` this repo's own `livewebview` plugin
 * owns, reached through `androidLiveWebview`. Every export below picks one and
 * behaves the same either way; `liveWebviewTransport` is where the choice
 * lives, and it is made *before* anything is constructed rather than
 * discovered afterwards by a call that fails.
 */

import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { WEB_PAGE_W } from "./webPage";
import {
  androidWebviewExists,
  closeAndroidWebview,
  createAndroidWebview,
  placeAndroidWebview,
  showAndroidWebview,
} from "./androidLiveWebview";
import { liveWebviewTransport, type LiveWebviewTransport } from "./liveWebviewSupport";
export { liveWebviewSupported } from "./liveWebviewSupport";
import { queued } from "./labelQueue";
import {
  READY_STATE_SCRIPT,
  SERIALIZE_PAGE_SCRIPT,
  SERIALIZE_POLL_SCRIPT,
} from "./webPageSerialize";

/**
 * Two webviews, two names.
 *
 * These used to share one label, which was survivable only because the reader
 * path short-circuited before the offscreen render on any page it could
 * extract — so in practice only one of them existed at a time. Whole-page mode
 * removed that accident: every open now runs the offscreen render, the live
 * pane wants a view for the same tab, and they collided on the identity.
 *
 * The symptom was "a webview with label 'lc-web-capture' already exists", but
 * the near miss is worse. `captureRenderedPage` closes by label when it is
 * done, and `openLiveWebview` closes by label before it opens: whichever ran
 * second would have torn down the other's view — the offscreen render killed
 * mid-serialise, or the page you were reading closed underneath you.
 *
 * They are different objects. One is a transient worker parked out of sight;
 * the other is the surface you are looking at. The Android plugin keys its
 * views on the same two names for the same reason.
 */
export const CAPTURE_WEBVIEW_LABEL = "lc-web-capture";
export const LIVE_WEBVIEW_LABEL = "lc-web-live";
const CAPTURE_WIDTH = WEB_PAGE_W;
const CAPTURE_HEIGHT = 800;
const LOAD_TIMEOUT_MS = 20_000;
/*
 * A script-built page is not finished when `readyState` says it is — the
 * framework still has to hydrate and paint. 1.5s caught simple pages and
 * snapshotted several heavy ones mid-build.
 */
const SETTLE_MS = 2_800;
const SERIALIZE_TIMEOUT_MS = 8_000;
const POLL_MS = 100;
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeLoader: Promise<Invoke | null> | null = null;

function loadInvoke(): Promise<Invoke | null> {
  if (!invokeLoader) {
    invokeLoader = import("@tauri-apps/api/core")
      .then((mod) => mod.invoke as Invoke)
      .catch(() => null);
  }
  return invokeLoader;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Which surface answers here, or refuse before anything is constructed.
 *
 * The old guard was a platform veto and the message said so. What it was
 * really protecting against has not changed: a view handed a rectangle by
 * something that cannot honour it is not a degraded view, it is a full-screen
 * one over the app that the close path cannot clear. The difference is that
 * Android now has a transport that *can* honour it, so the only case left to
 * refuse is a plain browser tab, where there is no native surface at all.
 */
function requireTransport(): Exclude<LiveWebviewTransport, "none"> {
  const transport = liveWebviewTransport();
  if (transport === "none") {
    throw new Error("page capture needs the Tauri shell");
  }
  return transport;
}

/**
 * Run a script in the labeled view and parse what comes back.
 *
 * One command for both transports. `webview_eval_json` reads its label from
 * wry on desktop and from the plugin on Android, and both hand back the JSON
 * encoding of the value — `eval_with_callback` and `evaluateJavascript` agree
 * on that — so the serializer below never learns which one answered.
 */
async function evalJson(label: string, script: string): Promise<unknown> {
  const invoke = await loadInvoke();
  if (!invoke) throw new Error("page capture needs the Tauri shell");
  const raw = await invoke<string>("webview_eval_json", { label, script });
  return JSON.parse(raw) as unknown;
}

async function waitUntil(
  label: string,
  script: string,
  ok: (value: unknown) => boolean,
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    last = await evalJson(label, script);
    if (ok(last)) return last;
    await sleep(POLL_MS);
  }
  throw new Error("the page took too long to finish loading");
}

/*
 * Taking a view away is the one direction that never refuses.
 *
 * `requireTransport` is for the calls that are about to *make* something. A
 * close is cleanup — it runs from a React unmount, unawaited, and where there
 * is no transport there was never a view either. Throwing there would turn
 * "nothing to do" into an unhandled rejection. The same is true of the place
 * and show below, which a pane can reach a frame before its view exists.
 */
async function closeByLabel(label: string): Promise<void> {
  const transport = liveWebviewTransport();
  if (transport === "none") return;
  if (transport === "android") {
    await closeAndroidWebview(label);
    return;
  }
  const existing = await Webview.getByLabel(label);
  if (existing) await existing.close();
}

async function closeCapture(): Promise<void> {
  await closeByLabel(CAPTURE_WEBVIEW_LABEL);
}

/** Viewport rectangle, in the same logical pixels the window uses. */
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The wry live view, if there is one.
 *
 * No longer exported, and null on Android rather than throwing. It answers a
 * question only one transport has an object for, so handing it out is handing
 * out "there is no live page" to a caller looking at one. `liveWebviewOpen` is
 * the question that survives both.
 */
async function liveWebview(): Promise<Webview | null> {
  if (liveWebviewTransport() !== "wry") return null;
  return (await Webview.getByLabel(LIVE_WEBVIEW_LABEL)) ?? null;
}

/** Whether a live page is open, whichever surface is holding it. */
export async function liveWebviewOpen(): Promise<boolean> {
  const transport = liveWebviewTransport();
  if (transport === "none") return false;
  if (transport === "android") {
    return androidWebviewExists(LIVE_WEBVIEW_LABEL);
  }
  return (await Webview.getByLabel(LIVE_WEBVIEW_LABEL)) != null;
}

/**
 * Open the page for real, over `rect`.
 *
 * Deliberately *not* hidden. `hide()` maps to `IsVisible = false` on Windows,
 * which suspends compositing and throttles timers in that view — fine for a
 * thing you are about to read once, wrong for one you are looking at, and a
 * plausible reason the old read-once capture was flaky even off-screen.
 */
export async function openLiveWebview(url: string, rect: PaneRect): Promise<void> {
  return queued(LIVE_WEBVIEW_LABEL, () => openLiveWebviewNow(url, rect));
}

async function openLiveWebviewNow(url: string, rect: PaneRect): Promise<void> {
  requireTransport();
  await closeByLabel(LIVE_WEBVIEW_LABEL);
  try {
    await createLiveWebview(url, rect);
  } catch (cause) {
    /*
     * "Already exists" survives the close above when Tauri's registry and the
     * native view disagree for a moment — the close resolves, the label is not
     * free yet. One more close and a frame is enough, and it is worth trying:
     * the alternative the reader sees is a red banner over a page that would
     * have opened. (The plugin replaces by label on create, so this is a wry
     * race and only ever fires there.)
     */
    if (!/already exists/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw cause;
    }
    await closeByLabel(LIVE_WEBVIEW_LABEL);
    await sleep(120);
    await createLiveWebview(url, rect);
  }
}

async function createLiveWebview(url: string, rect: PaneRect): Promise<void> {
  if (requireTransport() === "android") {
    await createAndroidWebview(LIVE_WEBVIEW_LABEL, url, rect, { userAgent: CHROME_UA });
    return;
  }
  const host = getCurrentWindow();
  const webview = new Webview(host, LIVE_WEBVIEW_LABEL, {
    url,
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
    focus: false,
    userAgent: CHROME_UA,
    incognito: true,
    javascriptDisabled: false,
  });
  await new Promise<void>((resolve, reject) => {
    void webview.once("tauri://created", () => resolve());
    void webview.once("tauri://error", (event) => {
      reject(new Error(String(event.payload ?? "could not open a web view")));
    });
  });
}

/** Follow the pane. Cheap enough to run from a ResizeObserver. */
export async function placeLiveWebview(rect: PaneRect): Promise<void> {
  const transport = liveWebviewTransport();
  if (transport === "none") return;
  if (transport === "android") {
    await placeAndroidWebview(LIVE_WEBVIEW_LABEL, rect);
    return;
  }
  const webview = await liveWebview();
  if (!webview) return;
  await webview.setPosition(new LogicalPosition(Math.round(rect.x), Math.round(rect.y)));
  await webview.setSize(
    new LogicalSize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height))),
  );
}

export async function showLiveWebview(show: boolean): Promise<void> {
  const transport = liveWebviewTransport();
  if (transport === "none") return;
  if (transport === "android") {
    await showAndroidWebview(LIVE_WEBVIEW_LABEL, show);
    return;
  }
  const webview = await liveWebview();
  // Nothing to show or hide is not a failure — a pane can ask before its view
  // has opened, or after the address it was on closed one.
  if (!webview) return;
  if (show) await webview.show();
  else await webview.hide();
}

export async function closeLiveWebview(): Promise<void> {
  await queued(LIVE_WEBVIEW_LABEL, () => closeByLabel(LIVE_WEBVIEW_LABEL));
}

/**
 * Freeze whatever the live view is showing.
 *
 * The same serialise the read-once capture did, but it leaves the view open —
 * the caller decides whether browsing continues.
 */
export async function serializeLiveWebview(): Promise<{ url: string; html: string }> {
  requireTransport();
  /*
   * Ask whether there is one before talking to it.
   *
   * The bridge answers "no webview named lc-web-live" when the label is gone,
   * which is a true statement about the machinery and no use at all to a reader
   * who pressed Freeze. The view can be gone legitimately — a pane unmounting,
   * an address change closing one before the next opens — so this is a race to
   * report plainly rather than a fault to hide.
   */
  if (!(await liveWebviewOpen())) {
    throw new Error("the live page has closed — open it again before freezing");
  }
  return runSerialize(LIVE_WEBVIEW_LABEL);
}

/** Wait for load + settle, then serialise. Shared by live and read-once. */
async function runSerialize(label: string): Promise<{ url: string; html: string }> {
  await waitUntil(
    label,
    READY_STATE_SCRIPT,
    (value) => value === "complete" || value === "interactive",
    LOAD_TIMEOUT_MS,
  );
  await sleep(SETTLE_MS);
  await evalJson(label, SERIALIZE_PAGE_SCRIPT);
  const payload = await waitUntil(
    label,
    SERIALIZE_POLL_SCRIPT,
    (value) => value != null,
    SERIALIZE_TIMEOUT_MS,
  );
  if (!payload || typeof payload !== "object") {
    throw new Error("the page did not return a snapshot");
  }
  const record = payload as { error?: string; result?: { url?: string; html?: string } };
  if (record.error) throw new Error(record.error);
  const html = record.result?.html;
  if (!html) throw new Error("the page did not return a snapshot");
  return { url: record.result?.url || "", html };
}

export async function captureRenderedPage(
  url: string,
  size?: { width?: number; height?: number },
): Promise<{ url: string; html: string }> {
  return queued(CAPTURE_WEBVIEW_LABEL, () => captureRenderedPageNow(url, size));
}

async function captureRenderedPageNow(
  url: string,
  size?: { width?: number; height?: number },
): Promise<{ url: string; html: string }> {
  const transport = requireTransport();
  await closeCapture();
  const width = size?.width && size.width > 0 ? Math.round(size.width) : CAPTURE_WIDTH;
  const height = size?.height && size.height > 0 ? Math.round(size.height) : CAPTURE_HEIGHT;
  if (transport === "android") {
    return captureViaPlugin(url, width, height);
  }
  const host = getCurrentWindow();
  const webview = new Webview(host, CAPTURE_WEBVIEW_LABEL, {
    url,
    x: 0,
    y: 10_000,
    width,
    height,
    focus: false,
    userAgent: CHROME_UA,
    incognito: true,
    javascriptDisabled: false,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      void webview.once("tauri://created", () => resolve());
      void webview.once("tauri://error", (event) => {
        reject(new Error(String(event.payload ?? "could not open a capture view")));
      });
    });
    /*
     * Off-screen, but not hidden.
     *
     * `hide()` is `IsVisible = false` on Windows, which suspends compositing
     * and throttles timers in that view — so the page it is meant to be running
     * stops running. `y: 10_000` already keeps it out of sight, and a child
     * webview is clipped to its parent window anyway.
     */
    const serialized = await runSerialize(CAPTURE_WEBVIEW_LABEL);
    return { url: serialized.url || url, html: serialized.html };
  } finally {
    try {
      await webview.close();
    } catch {
      await closeCapture();
    }
  }
}

/**
 * The same render, behind the app instead of past the edge of it.
 *
 * `y: 10_000` was wry's way of putting a live view where nobody would look,
 * and it is precisely the instruction Android ignored — which is how opening
 * any page in whole-page mode on a tablet ended with the page covering the
 * app. The plugin puts this view *under* the app's own WebView instead: an
 * opaque UI hides it as completely as the screen edge did, and unlike a `GONE`
 * view it is still laid out, so the page renders at the width it was asked to
 * render at and comes back as a document rather than a sliver.
 */
async function captureViaPlugin(
  url: string,
  width: number,
  height: number,
): Promise<{ url: string; html: string }> {
  await createAndroidWebview(
    CAPTURE_WEBVIEW_LABEL,
    url,
    { x: 0, y: 0, width, height },
    { behind: true, userAgent: CHROME_UA },
  );
  try {
    const serialized = await runSerialize(CAPTURE_WEBVIEW_LABEL);
    return { url: serialized.url || url, html: serialized.html };
  } finally {
    await closeAndroidWebview(CAPTURE_WEBVIEW_LABEL).catch(() => undefined);
  }
}
