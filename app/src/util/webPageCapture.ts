/**
 * Hidden Tauri webview that runs a page, then serializes the post-JS DOM.
 *
 * Not a UI pane — off-screen, closed in `finally`. Android has no child
 * webview command; callers fall back to `fetch_html`.
 */

import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { WEB_PAGE_W } from "./webPage";
import {
  READY_STATE_SCRIPT,
  SERIALIZE_PAGE_SCRIPT,
  SERIALIZE_POLL_SCRIPT,
} from "./webPageSerialize";

export const CAPTURE_WEBVIEW_LABEL = "lc-web-capture";
const CAPTURE_WIDTH = WEB_PAGE_W;
const CAPTURE_HEIGHT = 800;
const LOAD_TIMEOUT_MS = 20_000;
const SETTLE_MS = 1_500;
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

async function closeCapture(): Promise<void> {
  const existing = await Webview.getByLabel(CAPTURE_WEBVIEW_LABEL);
  if (existing) await existing.close();
}

export async function captureRenderedPage(
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
    await webview.hide();
    await waitUntil(
      CAPTURE_WEBVIEW_LABEL,
      READY_STATE_SCRIPT,
      (value) => value === "complete" || value === "interactive",
      LOAD_TIMEOUT_MS,
    );
    await sleep(SETTLE_MS);
    await evalJson(CAPTURE_WEBVIEW_LABEL, SERIALIZE_PAGE_SCRIPT);
    const payload = await waitUntil(
      CAPTURE_WEBVIEW_LABEL,
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
    const finalUrl = record.result?.url || url;
    if (!html) throw new Error("the page did not return a snapshot");
    return { url: finalUrl, html };
  } finally {
    try {
      await webview.close();
    } catch {
      await closeCapture();
    }
  }
}
