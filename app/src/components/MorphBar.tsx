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

export type MorphBarAxis = "height" | "width";

export interface MorphBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Which panel id is showing. */
  active: string;
  /** `height` for flyouts that grow upward; `width` for pill toolbars. */
  axis?: MorphBarAxis;
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
  className,
  children,
  ...shellProps
}: MorphBarProps) {
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(0);

  const panels = Children.toArray(children).filter(
    (child): child is ReactElement<{ "data-morph-id"?: string; children?: ReactNode }> =>
      isValidElement(child),
  );

  useLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure) return;

    const read = () => {
      const next =
        axis === "height" ? measure.scrollHeight : measure.scrollWidth;
      setSize(next);
    };

    read();
    if (prefersReducedMotion()) return;
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(read);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [active, axis, children]);

  const shellStyle: CSSProperties = {
    ...(typeof shellProps.style === "object" && shellProps.style
      ? shellProps.style
      : {}),
    ...(axis === "height" ? { height: size } : { width: size }),
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
