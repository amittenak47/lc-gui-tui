/**
 * The live page, in the hole this component reserves for it.
 *
 * A child web view is a native surface: it paints above every piece of HTML in
 * the app and nothing of ours can be drawn on top of it. So this renders an
 * empty box and keeps the view matched to that box's rectangle — the layout
 * is done in HTML, where layout belongs, and the view only ever follows.
 * Window resize and the split sash come free, because the box is laid out by
 * the same CSS as everything else and a ResizeObserver reports where it landed.
 *
 * Nothing here knows which surface it is following. On desktop it is wry's
 * child webview; on Android it is the `livewebview` plugin's own `WebView`,
 * because wry has none there. That was the whole design already — an HTML hole
 * measured and a native view told where it is — so adding the second transport
 * changed `webPageCapture`, not this file.
 *
 * That is also why there is nothing to draw here. While the page is live it
 * cannot be annotated; freezing it into a document is what makes ink possible,
 * and the two are separate states for exactly this reason.
 */

import { useEffect, useRef, useState } from "react";

import {
  onLiveWebviewBack,
  onLiveWebviewNavigated,
} from "../util/androidLiveWebview";
import { watchScreenOverlay } from "../util/screenOverlay";
import {
  closeLiveWebview,
  openLiveWebview,
  placeLiveWebview,
  showLiveWebview,
  LIVE_WEBVIEW_LABEL,
  type PaneRect,
} from "../util/webPageCapture";

export interface LiveWebPaneProps {
  /** The address to open. Changing it navigates the live view. */
  url: string;
  /**
   * Showing on screen. A parked tab hides the view rather than closing it —
   * closing would throw the page's session away, and a native surface left
   * visible would paint over whichever tab you switched to.
   */
  visible: boolean;
  onError?: (message: string) => void;
  /**
   * The system Back gesture, over the live pane.
   *
   * Android only. The plugin takes the gesture and acts on none of it: the
   * history worth walking is the app's, so the decision — step back, or leave
   * the pane because there is nothing behind — belongs to whoever owns that
   * history, which is not this component either.
   */
  onBack?: () => void;
  /**
   * The live view went somewhere — a tapped link, a search, a `pushState`.
   *
   * The pane opens at `url` and the page is free to leave it. Nothing else in
   * the app can see that happen: the view is a native surface with its own
   * history, so without this the omnibox, Back/Forward and Freeze all keep
   * describing the address the tab opened at.
   */
  onNavigate?: (url: string) => void;
}

function rectOf(node: HTMLElement): PaneRect {
  const box = node.getBoundingClientRect();
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

export function LiveWebPane({
  url,
  visible,
  onError,
  onBack,
  onNavigate,
}: LiveWebPaneProps) {
  const holeRef = useRef<HTMLDivElement | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  /*
   * Follow the page's own address.
   *
   * Bound for the life of the pane rather than per address: the whole point is
   * the addresses this component was never told about.
   */
  useEffect(
    () =>
      onLiveWebviewNavigated(
        (next) => onNavigateRef.current?.(next),
        LIVE_WEBVIEW_LABEL,
      ),
    [],
  );

  /*
   * Back belongs to whoever owns the history, which is neither of us.
   *
   * The subscription is a `window` listener, so it costs nothing where nothing
   * ever dispatches — desktop keeps the wry view and never sends this. Bound
   * once for the life of the pane rather than per address: history survives a
   * navigation, and so should the way out of it.
   */
  useEffect(() => onLiveWebviewBack(() => onBackRef.current?.()), []);

  /**
   * Bumped when a view finishes opening, so the visibility effect re-runs.
   *
   * A new view is born showing, and the effect that would have parked it ran
   * while there was still nothing to park — mount a pane that is already off
   * screen and the page arrives a moment later, on top of whatever tab you are
   * actually looking at. Asserting the state again once the view exists is the
   * cheap half of the fix; the other half would be teaching every transport to
   * open hidden, which costs a flash on the common path where it is wanted.
   */
  const [opened, setOpened] = useState(0);

  /*
   * Open once per address; navigating re-opens rather than reusing.
   *
   * Wry's JS API has no `navigate` on a child webview, so on desktop this is
   * the only way. The Android plugin could `loadUrl` an open view instead, and
   * deliberately does not expose it: one path through this is worth more than
   * a tablet that keeps page history across an address change the desktop
   * throws away, and the reader's Back is the page's own history either way.
   */
  useEffect(() => {
    const node = holeRef.current;
    if (!node) return;
    let cancelled = false;
    void openLiveWebview(url, rectOf(node)).then(
      () => {
        if (!cancelled) setOpened((n) => n + 1);
      },
      (cause: unknown) => {
        if (cancelled) return;
        onErrorRef.current?.(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
      void closeLiveWebview();
    };
  }, [url]);

  /*
   * Follow the hole — once per frame, and only when it has moved.
   *
   * A ResizeObserver catches layout changes the window never hears about — the
   * split sash, the agent panel opening — and `scroll` catches the page moving
   * under a scroll without resizing. `scroll` is registered in the capture
   * phase, which means every scroller in the app, and a momentum scroll fires
   * it at display rate. A place is not the "two IPC calls" it reads as: on
   * desktop it is a `get_all_webviews` to resolve the label, then
   * `setPosition`, then `setSize` — three round trips, each awaited — and on
   * Android it is one command that ends in a `requestLayout` on the UI thread,
   * which is the thread everything else is drawn on. Unthrottled, either is
   * enough traffic to sit on the bridge, and freezing a page dispatches five
   * synthetic resizes of its own (see `Workspace`).
   *
   * So: coalesce to one placement per frame, and drop it entirely when the
   * rectangle is where it already was, which is what most of those events say.
   */
  useEffect(() => {
    const node = holeRef.current;
    if (!node) return;
    let frame: number | null = null;
    let placed: PaneRect | null = null;
    const same = (a: PaneRect, b: PaneRect) =>
      Math.round(a.x) === Math.round(b.x) &&
      Math.round(a.y) === Math.round(b.y) &&
      Math.round(a.width) === Math.round(b.width) &&
      Math.round(a.height) === Math.round(b.height);
    const placeNow = () => {
      const hole = holeRef.current;
      if (!hole) return;
      const rect = rectOf(hole);
      if (placed && same(placed, rect)) return;
      placed = rect;
      void placeLiveWebview(rect);
    };
    const place = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        placeNow();
      });
    };
    placeNow();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(node);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [url]);

  /*
   * Step aside for anything that takes the whole screen.
   *
   * Settings opened *behind* the page: the panel was there, the header blurred
   * around it, and a native surface painted over the rest. Nothing of ours can
   * be drawn above this view — that is the same constraint that makes the board
   * chrome disappear while a page is live — so the only move is to take the
   * view away for as long as the panel is up, and put it back afterwards.
   *
   * What shows through underneath is the frozen copy of the page, which is the
   * right thing to be dimming behind a dialog anyway.
   */
  const [overlay, setOverlay] = useState(false);
  useEffect(() => watchScreenOverlay(setOverlay), []);

  useEffect(() => {
    void showLiveWebview(visible && !overlay);
  }, [visible, overlay, opened]);

  return <div ref={holeRef} className="lc-live-web-pane" aria-hidden />;
}
