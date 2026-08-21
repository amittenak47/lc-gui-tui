/**
 * The live page, in the hole this component reserves for it.
 *
 * A child WebView2 is a native surface: it paints above every piece of HTML in
 * the app and nothing of ours can be drawn on top of it. So this renders an
 * empty box and keeps the webview matched to that box's rectangle — the layout
 * is done in HTML, where layout belongs, and the webview only ever follows.
 * Window resize and the split sash come free, because the box is laid out by
 * the same CSS as everything else and a ResizeObserver reports where it landed.
 *
 * That is also why there is nothing to draw here. While the page is live it
 * cannot be annotated; freezing it into a document is what makes ink possible,
 * and the two are separate states for exactly this reason.
 */

import { useEffect, useRef, useState } from "react";

import { watchScreenOverlay } from "../util/screenOverlay";
import {
  closeLiveWebview,
  openLiveWebview,
  placeLiveWebview,
  showLiveWebview,
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
}

function rectOf(node: HTMLElement): PaneRect {
  const box = node.getBoundingClientRect();
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

export function LiveWebPane({ url, visible, onError }: LiveWebPaneProps) {
  const holeRef = useRef<HTMLDivElement | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Open once per address; navigating re-opens rather than reusing, because the
  // JS API has no `navigate` on a child webview.
  useEffect(() => {
    const node = holeRef.current;
    if (!node) return;
    let cancelled = false;
    void openLiveWebview(url, rectOf(node)).catch((cause: unknown) => {
      if (cancelled) return;
      onErrorRef.current?.(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      void closeLiveWebview();
    };
  }, [url]);

  /*
   * Follow the hole.
   *
   * A ResizeObserver catches layout changes the window never hears about — the
   * split sash, the agent panel opening — and `scroll` catches the page moving
   * under a scroll without resizing. Both are cheap: two IPC calls that set a
   * rectangle.
   */
  useEffect(() => {
    const node = holeRef.current;
    if (!node) return;
    const place = () => {
      if (!holeRef.current) return;
      void placeLiveWebview(rectOf(holeRef.current));
    };
    place();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(node);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
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
  }, [visible, overlay]);

  return <div ref={holeRef} className="lc-live-web-pane" aria-hidden />;
}
