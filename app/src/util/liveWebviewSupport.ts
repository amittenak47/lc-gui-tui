/**
 * Which transport can hold a live page inside a pane here.
 *
 * Its own module, with no Tauri imports, because the answer is needed during
 * render to decide whether to *offer* Browse — and the module that does the
 * browsing is loaded on demand precisely so the webview APIs are not pulled
 * into the main bundle.
 *
 * This was a platform veto, and the veto was aimed one layer too low. The
 * blocker was never Android: Android System WebView renders live pages as well
 * as anything. It was **wry's** Android backend, which maps `new_as_child`
 * onto `new` and whose `set_bounds` and `set_visible` return `Ok` and do
 * nothing — so a view opened through it cannot be confined to the hole the
 * layout reserves, and cannot be hidden when its tab is parked. Those two
 * calls are what `LiveWebPane` is made of, which is why the answer was no.
 *
 * `android.webkit.WebView` has neither problem, and the repo already routes
 * around wry gaps with its own Kotlin plugins three times over. The fourth is
 * `livewebview`, so the question stopped being "which platform is this" and
 * became "which transport answers here":
 *
 * - **wry** — desktop, the child webview the JS `Webview` API drives;
 * - **android** — the plugin's native view, reached through `live_webview_*`;
 * - **none** — a plain browser (`npm run dev`), where there is no shell at all
 *   and a `new Webview` would only throw further down.
 *
 * Not asking cost twice: Browse was offered on a tablet, threw a Tauri error
 * object into the header banner, and fell back to the fetched copy without
 * saying why — the copy that does not look like the page. Then it was taken
 * away on the tablet entirely, which was honest and still wrong.
 *
 * The user agent here is the app's own shell, not a remote page's claim about
 * itself, so reading it is a platform check rather than a guess.
 */

/** How a live page is held on this platform, or that it cannot be. */
export type LiveWebviewTransport = "wry" | "android" | "none";

function currentUserAgent(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

function inTauriShell(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

/**
 * The transport for this platform.
 *
 * Both arguments are test seams; left alone it reads the running shell. The
 * shell check is part of the answer rather than something every caller ANDs in
 * afterwards — a plain browser has no native surface to offer under either
 * name, and a guard that forgets to ask is how a `new Webview` reaches code
 * that cannot serve it.
 */
export function liveWebviewTransport(
  userAgent?: string,
  hasShell?: boolean,
): LiveWebviewTransport {
  const shell = hasShell ?? inTauriShell();
  if (!shell) return "none";
  const ua = userAgent ?? currentUserAgent();
  if (!ua) return "none";
  return /\bandroid\b/i.test(ua) ? "android" : "wry";
}

/** Whether a live page can be held at all — any transport but `none`. */
export function liveWebviewSupported(userAgent?: string, hasShell?: boolean): boolean {
  return liveWebviewTransport(userAgent, hasShell) !== "none";
}
