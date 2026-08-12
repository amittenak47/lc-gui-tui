/**
 * Hold-to-confirm stand-in for Excalidraw's "Scroll back to content" button.
 *
 * Excalidraw mounts a tap-to-jump control when the camera drifts off the scene.
 * A tap mid-pan is too easy to hit by accident on a reading board, so we mute
 * theirs (CSS keeps it in the tree for detection) and mirror visibility with a
 * {@link HoldButton} that only jumps once the fill completes.
 */

import { useEffect, useState, type RefObject } from "react";

import { HoldButton } from "../components/HoldButton";
import { HOLD_MS } from "../util/gesture";

const NATIVE_SEL = ".scroll-back-to-content";

function nativeScrollBackShown(root: HTMLElement): boolean {
  const native = root.querySelector(NATIVE_SEL) as HTMLElement | null;
  if (!native?.isConnected) return false;
  const style = window.getComputedStyle(native);
  if (style.display === "none" || style.visibility === "hidden") return false;
  /*
   * Mute CSS zeros opacity / pointer-events but leaves display + box size, so
   * Excalidraw's show/hide still shows up as a non-zero layout box.
   */
  return native.offsetWidth > 0 || native.offsetHeight > 0;
}

export function ScrollBackHold({
  boardRef,
  onScrollBack,
}: {
  boardRef: RefObject<HTMLElement | null>;
  onScrollBack: () => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const root = boardRef.current;
    if (!root) return;

    const sync = () => setVisible(nativeScrollBackShown(root));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
    /*
     * Excalidraw sometimes toggles the button from scroll handlers without a
     * mutation we catch — poll lightly while mounted.
     */
    const timer = window.setInterval(sync, 400);
    return () => {
      obs.disconnect();
      window.clearInterval(timer);
    };
  }, [boardRef]);

  if (!visible) return null;

  return (
    <HoldButton
      label="Scroll back to content"
      className="lc-scroll-back-hold"
      holdMs={HOLD_MS}
      onConfirm={onScrollBack}
      ariaLabel="Hold to scroll back to content"
    />
  );
}
