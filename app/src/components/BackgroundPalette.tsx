/**
 * Background colour swatches for board + UI chrome.
 * Inline in the problem browser, or a compact popover in the header / map chrome.
 */

import { useEffect, useRef, useState } from "react";

import { APP_THEMES } from "../theme/appThemes";

export interface BackgroundPaletteProps {
  themeId: string;
  onPick: (id: string) => void;
  /** `inline` in the browser footer; `compact`/`header`/`map` are popovers. */
  variant?: "inline" | "compact" | "header" | "map";
}

export function BackgroundPalette({ themeId, onPick, variant = "compact" }: BackgroundPaletteProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = APP_THEMES.find((theme) => theme.id === themeId) ?? APP_THEMES[0];

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  if (variant === "inline") {
    return (
      <div className="lc-bg-palette lc-bg-palette-inline" role="group" aria-label="Background colour">
        <span className="lc-bg-palette-label">Appearance</span>
        <div className="lc-bg-palette-swatches">
          {APP_THEMES.map((theme) => (
            <Swatch
              key={theme.id}
              theme={theme}
              active={theme.id === themeId}
              onPick={onPick}
              tipPlacement="top"
            />
          ))}
        </div>
      </div>
    );
  }

  const tipPlacement = variant === "header" ? "bottom" : variant === "map" ? "top" : "left";
  const popoverClass =
    variant === "header"
      ? "lc-palette-popover lc-palette-popover-header"
      : variant === "map"
        ? "lc-palette-popover lc-palette-popover-map"
        : "lc-palette-popover";

  return (
    <div
      ref={rootRef}
      className={`lc-palette-compact${variant === "header" ? " lc-palette-header" : ""}${variant === "map" ? " lc-palette-map" : ""}${open ? " lc-palette-compact-open" : ""}`}
    >
      <button
        type="button"
        className={
          variant === "header"
            ? "lc-palette-trigger lc-palette-trigger-header lc-tip-target lc-secondary"
            : variant === "map"
              ? "lc-map-btn lc-palette-trigger lc-palette-trigger-map lc-tip-target"
              : "lc-map-btn lc-palette-trigger lc-tip-target"
        }
        style={
          variant === "header" || variant === "map"
            ? undefined
            : { background: current.background }
        }
        data-tip="Board and UI appearance"
        data-tip-placement={tipPlacement}
        aria-label="Appearance"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {variant === "header" && (
          <>
            <span className="lc-palette-chip" style={{ background: current.background }} aria-hidden />
            Appearance
          </>
        )}
        {variant === "map" && (
          <span className="lc-palette-map-label">
            <span className="lc-palette-chip" style={{ background: current.background }} aria-hidden />
            Appearance
          </span>
        )}
      </button>
      {open && (
        <div className={popoverClass} role="listbox" aria-label="Background colour">
          {APP_THEMES.map((theme) => (
            <Swatch
              key={theme.id}
              theme={theme}
              active={theme.id === themeId}
              onPick={(id) => {
                onPick(id);
                setOpen(false);
              }}
              tipPlacement={tipPlacement}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Swatch({
  theme,
  active,
  onPick,
  tipPlacement,
}: {
  theme: (typeof APP_THEMES)[number];
  active: boolean;
  onPick: (id: string) => void;
  tipPlacement: "top" | "left" | "bottom";
}) {
  return (
    <button
      type="button"
      role="option"
      className={
        active
          ? "lc-swatch lc-swatch-active lc-tip-target"
          : theme.mode === "dark"
            ? "lc-swatch lc-swatch-dark lc-tip-target"
            : "lc-swatch lc-tip-target"
      }
      style={{ background: theme.background }}
      data-tip={theme.label}
      data-tip-placement={tipPlacement}
      aria-label={`${theme.label} background`}
      aria-selected={active}
      onClick={() => onPick(theme.id)}
    />
  );
}
