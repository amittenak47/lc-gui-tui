/**
 * Compact filter control for the problem browser.
 *
 * Native `<select>` sizes its closed width to the longest `<option>` — a long
 * tag list blows the filter row. This button + scroll-pane menu keeps a fixed
 * trigger width and uses the same scrollbar chrome as Settings.
 */

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface BrowserFilterOption {
  value: string;
  label: string;
}

export interface BrowserFilterSelectProps {
  className?: string;
  value: string;
  options: readonly BrowserFilterOption[];
  /** Shown on the closed trigger when `value` is empty. Not a menu row. */
  placeholder: string;
  "aria-label": string;
  onChange: (value: string) => void;
}

export function BrowserFilterSelect({
  className,
  value,
  options,
  placeholder,
  "aria-label": ariaLabel,
  onChange,
}: BrowserFilterSelectProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [menuBox, setMenuBox] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const selected = options.find((option) => option.value === value);
  const triggerLabel = selected?.label || placeholder;

  useEffect(() => {
    if (!open) {
      setMenuBox(null);
      return;
    }
    const place = () => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const pad = 8;
      const maxHeight = Math.min(280, Math.max(120, window.innerHeight - rect.bottom - pad));
      setMenuBox({
        left: rect.left,
        top: rect.bottom + 4,
        width: Math.max(rect.width, 160),
        maxHeight,
      });
    };
    place();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !menuRef.current) return;
    menuRef.current.scrollTop = 0;
  }, [open, menuBox]);

  return (
    <div
      ref={rootRef}
      className={["lc-filter-select", className].filter(Boolean).join(" ")}
    >
      <button
        type="button"
        className={
          open
            ? "lc-filter-select-trigger is-open"
            : value
              ? "lc-filter-select-trigger has-value"
              : "lc-filter-select-trigger"
        }
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="lc-filter-select-label">{triggerLabel}</span>
      </button>
      {open &&
        menuBox &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            className="lc-filter-select-menu lc-scroll-pane"
            role="listbox"
            aria-label={ariaLabel}
            style={{
              left: menuBox.left,
              top: menuBox.top,
              width: menuBox.width,
              maxHeight: menuBox.maxHeight,
            }}
          >
            {options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value || "__any__"}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={
                    active
                      ? "lc-filter-select-option is-active"
                      : "lc-filter-select-option"
                  }
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
