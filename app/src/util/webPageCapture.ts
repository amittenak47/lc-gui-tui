/**
 * The real browser, borrowed.
 *
 * A Tauri child WebView2 that loads a page for real — its JavaScript runs, its
 * CSS applies, its fonts load. Two things are done with it:
 *
 * - **Live**: shown over the pane, so the reader can actually browse. This is
 *   the only way a page ever looks like itself; a serialised DOM is a
 *   reconstruction and always will be.
 * - **Frozen**: serialised into HTML the pad can paint under ink. That is what
 *   makes a page annotatable, and it costs the fidelity above — which is why
 *   browsing and annotating are two states rather than one.
 *
 * The webview paints above all HTML, so nothing of ours can be drawn over it
 * while it is live. Android has no child webview command; callers fall back to
 * `fetch_html`.
 */

import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { WEB_PAGE_W } from "./webPage";
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
 * They are different objects. One is a transient worker parked off-screen; the
 * other is the surface you are looking at.
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

async function closeByLabel(label: string): Promise<void> {
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

/** The live view, if there is one. */
export async function liveWebview(): Promise<Webview | null> {
  return (await Webview.getByLabel(LIVE_WEBVIEW_LABEL)) ?? null;
}

/**
 * Open the page for real, over `rect`.
 *
 * Deliberately *not* hidden. `hide()` maps to `IsVisible = false` on Windows,
 * which suspends compositing and throttles timers in that view — fine for a
 * thing you are about to read once, wrong for one you are looking at, and a
 * plausible reason the old read-once capture was flaky even off-screen.
 */
export async function openLiveWebview(url: string, rect: PaneRect): Promise<Webview> {
  return queued(LIVE_WEBVIEW_LABEL, () => openLiveWebviewNow(url, rect));
}

async function openLiveWebviewNow(url: string, rect: PaneRect): Promise<Webview> {
  await closeByLabel(LIVE_WEBVIEW_LABEL);
  try {
    return await createLiveWebview(url, rect);
  } catch (cause) {
    /*
     * "Already exists" survives the close above when Tauri's registry and the
     * native view disagree for a moment — the close resolves, the label is not
     * free yet. One more close and a frame is enough, and it is worth trying:
     * the alternative the reader sees is a red banner over a page that would
     * have opened.
     */
    if (!/already exists/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw cause;
    }
    await closeByLabel(LIVE_WEBVIEW_LABEL);
    await sleep(120);
    return createLiveWebview(url, rect);
  }
}

async function createLiveWebview(url: string, rect: PaneRect): Promise<Webview> {
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
  return webview;
}

/** Follow the pane. Cheap enough to run from a ResizeObserver. */
export async function placeLiveWebview(rect: PaneRect): Promise<void> {
  const webview = await liveWebview();
  if (!webview) return;
  await webview.setPosition(new LogicalPosition(Math.round(rect.x), Math.round(rect.y)));
  await webview.setSize(
    new LogicalSize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height))),
  );
}

export async function showLiveWebview(show: boolean): Promise<void> {
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
  /*
   * Ask whether there is one before talking to it.
   *
   * The bridge answers "no webview named lc-web-live" when the label is gone,
   * which is a true statement about the machinery and no use at all to a reader
   * who pressed Freeze. The view can be gone legitimately — a pane unmounting,
   * an address change closing one before the next opens — so this is a race to
   * report plainly rather than a fault to hide.
   */
  if (!(await liveWebview())) {
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
  await closeCapture();
  const host = getCurrentWindow();
  const width = size?.width && size.width > 0 ? Math.round(size.width) : CAPTURE_WIDTH;
  const height = size?.height && size.height > 0 ? Math.round(size.height) : CAPTURE_HEIGHT;
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
