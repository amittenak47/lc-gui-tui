/**
 * The Android transport: a native `WebView` the app owns, not one wry made.
 *
 * Thin on purpose. Every function here is the Android half of a
 * `webPageCapture` export, in the same order and with the same meaning, so the
 * two can be read side by side — the pane's design does not change because the
 * surface underneath it does. The Kotlin that does the work is
 * `plugins/livewebview/android/src/main/java/LiveWebViewPlugin.kt`; the shape
 * of the bridge is the one `gestureExclusion.ts` already uses, an `invoke` of
 * this crate's own command rather than the plugin's, so the capability file
 * carries one permission rather than one per command.
 *
 * Rectangles go across in **CSS pixels relative to the viewport** — exactly
 * what `getBoundingClientRect` returns — plus `devicePixelRatio`. Kotlin adds
 * the Tauri WebView's screen origin and the scale. Doing the conversion on
 * this side would mean the layout code knew about device pixels, and it is the
 * one thing here that has no business knowing.
 */

/** Viewport rectangle in CSS pixels. Structurally the pane's `PaneRect`. */
export interface LiveRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Back ran past the beginning of the page's history.
 *
 * Dispatched on `window` by the plugin, in the app's own WebView. While a live
 * pane is up the plugin takes Back for the page — that is what makes it a
 * browser rather than a picture — and when there is no earlier page left, the
 * next honest step is to leave the pane, not the app. Which is a decision the
 * pane owns, so it is told rather than acted on.
 *
 * Must match `BACK_EXHAUSTED_EVENT` in `LiveWebViewPlugin.kt`.
 */
export const BACK_EXHAUSTED_EVENT = "lc-live-webview-back-exhausted";

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

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const invoke = await loadInvoke();
  if (!invoke) throw new Error("a live page needs the Tauri shell");
  return invoke<T>(cmd, args);
}

function density(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

/** Whole pixels, and never a zero-area view — Android lays one out at nothing. */
function whole(rect: LiveRect): LiveRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

export interface AndroidWebviewOptions {
  /**
   * Behind the app rather than over it — the offscreen render.
   *
   * The wry path parked that view at `y: 10_000`, which is the trick Android
   * ignored and the reason a tablet ended up with a full-screen page nobody
   * asked for. Under an opaque app is the same invisibility without the lie:
   * the view is still laid out at the size the page should be rendered at, so
   * what comes back is a document and not a one-pixel column.
   */
  behind?: boolean;
  userAgent?: string;
}

export async function createAndroidWebview(
  label: string,
  url: string,
  rect: LiveRect,
  opts?: AndroidWebviewOptions,
): Promise<void> {
  await call<void>("live_webview_create", {
    label,
    url,
    rect: whole(rect),
    density: density(),
    userAgent: opts?.userAgent ?? null,
    behind: Boolean(opts?.behind),
  });
}

export async function placeAndroidWebview(label: string, rect: LiveRect): Promise<void> {
  await call<void>("live_webview_place", {
    label,
    rect: whole(rect),
    density: density(),
  });
}

export async function showAndroidWebview(label: string, visible: boolean): Promise<void> {
  await call<void>("live_webview_show", { label, visible });
}

export async function closeAndroidWebview(label: string): Promise<void> {
  await call<void>("live_webview_close", { label });
}

export async function androidWebviewExists(label: string): Promise<boolean> {
  return call<boolean>("live_webview_exists", { label });
}

/**
 * Listen for Back running out of page history. Returns an unsubscribe.
 *
 * A DOM event rather than a plugin channel: the sender is Kotlin evaluating one
 * line in the app's own WebView, there is exactly one listener, and the event
 * carries nothing because there is one live label and nothing else to say. A
 * no-op where `window` does not exist, so the pane can call it unconditionally.
 */
export function onLiveWebviewBackExhausted(onExhausted: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(BACK_EXHAUSTED_EVENT, onExhausted);
  return () => window.removeEventListener(BACK_EXHAUSTED_EVENT, onExhausted);
}
