/**
 * Which half of a split just took focus.
 *
 * The pen island is shared by both panes and it stopped re-animating when focus
 * moves (MorphBar `animateOnMount`), which is the right call — a toolbar that
 * was never put down should not look like it is being picked up again — but it
 * also removed the only signal that anything had happened. This is the
 * replacement: a pill on the pane that now has focus, for about a second.
 *
 * Deliberately silent on mount. Opening a split is not a focus *change*, and a
 * label that fires as the panes appear reads as a startup artefact.
 */

import { useEffect, useRef, useState } from "react";

/** Long enough to read two or three words, short enough not to be chrome. */
const HOLD_MS = 1100;

export function SplitFocusToast({
  side,
  label,
}: {
  side: "a" | "b";
  label: string;
}) {
  const [shown, setShown] = useState(false);
  const firstRef = useRef(true);

  /*
   * `side` alone is the trigger. A pane retitling itself — a web pad following
   * a link, a pad being renamed — is not focus moving, and toasting on it would
   * make the label pop up while the reader is drawing.
   */
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    setShown(true);
    const timer = window.setTimeout(() => setShown(false), HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [side]);

  return (
    <div
      className={[
        "lc-split-focus-toast",
        `is-${side}`,
        shown ? "is-visible" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden
    >
      <span>{label}</span>
    </div>
  );
}
