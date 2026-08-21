/**
 * Whether this platform can hold a live page inside a pane.
 *
 * Its own module, with no Tauri imports, because the answer is needed during
 * render to decide whether to *offer* Browse — and the module that does the
 * browsing is loaded on demand precisely so the webview APIs are not pulled
 * into the main bundle.
 *
 * The answer on Android is no, and more thoroughly than "no child webview
 * command" suggests: wry's Android backend maps `new_as_child` onto `new`, and
 * its `set_bounds` and `set_visible` are no-ops that return `Ok`. A view opened
 * there cannot be confined to the hole the layout reserves for it, and cannot
 * be hidden when its tab is parked. Those two calls are what `LiveWebPane` is
 * made of.
 *
 * Not asking cost twice: Browse was offered on a tablet, threw a Tauri error
 * object into the header banner, and fell back to the fetched copy without
 * saying why — the copy that does not look like the page.
 *
 * The user agent here is the app's own shell, not a remote page's claim about
 * itself, so reading it is a platform check rather than a guess.
 */
export function liveWebviewSupported(userAgent?: string): boolean {
  const ua =
    userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  if (!ua) return false;
  return !/\bandroid\b/i.test(ua);
}
