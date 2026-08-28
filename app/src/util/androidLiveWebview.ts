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
 * Back was pressed over the live pane.
 *
 * Dispatched on `window` by the plugin, in the app's own WebView. The plugin
 * takes the gesture — that is what makes the pane a browser rather than a
 * picture of one — but it does not act on it, because the history worth
 * walking is the app's and not the native view's. The app steps its own
 * entries, or leaves the pane when there is nothing behind.
 *
 * Must match `BACK_EVENT` in `LiveWebViewPlugin.kt`.
 */
export const BACK_EVENT = "lc-live-webview-back";

/**
 * The live view has moved to another address.
 *
 * The app opens the view at a URL and, until this existed, never heard another
 * word — so tapping through links left the omnibox reading the address you
 * started at, Back and Forward holding the single entry they were born with,
 * and Freeze naming the page you were on after the page you came from. Fires
 * for `pushState` too, not just full loads.
 *
 * Must match `NAVIGATED_EVENT` in `LiveWebViewPlugin.kt`.
 */
export const NAVIGATED_EVENT = "lc-live-webview-navigated";

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
 * Listen for Back over the live pane. Returns an unsubscribe.
 *
 * A DOM event rather than a plugin channel: the sender is Kotlin evaluating one
 * line in the app's own WebView, and it goes one way. Filtered by label like
 * the navigation event beside it — a split has two live views, and one gesture
 * over one of them used to walk both tabs back a page.
 *
 * A no-op where `window` does not exist, so the pane can call it
 * unconditionally.
 */
export function onLiveWebviewBack(onBack: () => void, label?: string): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    const row = detail && typeof detail === "object" ? (detail as { label?: unknown }) : null;
    if (label && row && typeof row.label === "string" && row.label !== label) return;
    onBack();
  };
  window.addEventListener(BACK_EVENT, handler);
  return () => window.removeEventListener(BACK_EVENT, handler);
}

/**
 * Follow the live view's address. Returns an unsubscribe.
 *
 * Filtered to the live label: the offscreen render never reports, but a caller
 * should not have to know that to be correct.
 */
export function onLiveWebviewNavigated(
  onNavigated: (url: string) => void,
  label?: string,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== "object") return;
    const row = detail as { label?: unknown; url?: unknown };
    if (typeof row.url !== "string" || !row.url) return;
    if (label && row.label !== label) return;
    onNavigated(row.url);
  };
  window.addEventListener(NAVIGATED_EVENT, handler);
  return () => window.removeEventListener(NAVIGATED_EVENT, handler);
}
