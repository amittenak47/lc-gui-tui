/**
 * A bar that changes shape instead of swapping panels.
 *
 * Inspired by Drawesome's MorphBar: measure the active panel, animate the
 * container's height (or width), stack panels absolutely and cross-fade.
 * Zero animation library — CSS transition + ResizeObserver.
 */

import {
  Children,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

export type MorphBarAxis = "height" | "width" | "depth";

export interface MorphBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Which panel id is showing. */
  active: string;
  /**
   * `height` for flyouts that grow upward; `width` for pill toolbars; `depth`
   * keeps its box and swaps labels by rotating them in Z.
   */
  axis?: MorphBarAxis;
  /**
   * Play the shell's grow-from-nothing on the first commit.
   *
   * On by default — a bar that appears because you opened it should look like
   * it opened. Off when the mount is a handover rather than an opening: a
   * split swapping which pane owns the one toolbar re-mounts this, and
   * replaying the morph on every tab switch reads as a glitch, not an entrance.
   */
  animateOnMount?: boolean;
  children: ReactNode;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Each direct child should be a panel with `data-morph-id`.
 * Put `role` / `aria-label` on MorphBar itself (shell), not only on the child.
 */
export function MorphBar({
  active,
  axis = "height",
  animateOnMount = true,
  className,
  children,
  ...shellProps
}: MorphBarProps) {
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(0);
  const firstReadRef = useRef(true);
  /* Held for exactly the commit that writes the first size, then released. */
  const [snap, setSnap] = useState(!animateOnMount);

  const panels = Children.toArray(children).filter(
    (child): child is ReactElement<{ "data-morph-id"?: string; children?: ReactNode }> =>
      isValidElement(child),
  );

  useLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure) return;

    if (axis === "depth") {
      // Depth shells never resize — the panels cross-fade through rotateY
      // inside a fixed box, so there is nothing to measure. The handover
      // snap still has to be released, or the cross-fade would stay frozen.
      if (firstReadRef.current) {
        firstReadRef.current = false;
        if (!animateOnMount) requestAnimationFrame(() => setSnap(false));
      }
      return () => {};
    }

    const read = () => {
      if (axis === "height") {
        setSize(measure.scrollHeight);
        return;
      }
      // Width shells start at 0 with overflow:hidden. Measure max-content so
      // flex children are not squeezed before the first size commit.
      const previous = measure.style.width;
      measure.style.width = "max-content";
      const next = measure.scrollWidth;
      measure.style.width = previous;
      setSize(next);
    };

    read();
    if (firstReadRef.current) {
      firstReadRef.current = false;
      // The size lands with `transition: none` on; drop it next frame so every
      // change after this one animates normally.
      if (!animateOnMount) requestAnimationFrame(() => setSnap(false));
    }
    if (prefersReducedMotion()) return;
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(read);
    observer.observe(measure);
    return () => observer.disconnect();
    /*
     * `children` is deliberately not a dependency.
     *
     * JSX allocates a fresh children object on every render, so listing it
     * re-ran this layout effect every time the parent re-rendered: tear down
     * the ResizeObserver, build a new one, and call `scrollHeight`, which
     * forces a synchronous full-layout reflow. On the preset sheet that landed
     * on the input path — a reflow of the whole sheet per pointermove of a
     * slider — and it is what made the knobs stutter and the sheet impossible
     * to flick-scroll. Content that actually changes size still re-measures:
     * that is the ResizeObserver's job, and it is already watching.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, animateOnMount, axis]);

  const shellStyle: CSSProperties = {
    ...(typeof shellProps.style === "object" && shellProps.style
      ? shellProps.style
      : {}),
    ...(axis === "height"
      ? { height: size }
      : axis === "width"
        ? { width: size }
        : {}),
    ...(snap ? { transition: "none" } : {}),
  };

  return (
    <div
      {...shellProps}
      className={["lc-morph-bar", className].filter(Boolean).join(" ")}
      data-axis={axis}
      style={shellStyle}
    >
      {panels.map((panel) => {
        const id = panel.props["data-morph-id"];
        if (!id) return panel;
        const isActive = id === active;
        return (
          <div
            key={id}
            ref={isActive ? measureRef : undefined}
            className={
              isActive ? "lc-morph-panel is-active" : "lc-morph-panel"
            }
            data-active={isActive ? "true" : undefined}
            aria-hidden={!isActive}
          >
            {panel.props.children}
          </div>
        );
      })}
    </div>
  );
}
