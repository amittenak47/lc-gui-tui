/**
 * Background colour swatches for board + UI chrome.
 * Inline in the problem browser, or a compact popover in the header / map chrome.
 */

import { useEffect, useRef, useState } from "react";

import { APP_THEMES, type AppTheme } from "../theme/appThemes";

export interface BackgroundPaletteProps {
  themeId: string;
  onPick: (id: string) => void;
  /** `inline` in the browser footer; `compact`/`header`/`map` are popovers. */
  variant?: "inline" | "compact" | "header" | "map";
}

const LIGHT_THEMES = APP_THEMES.filter((theme) => theme.mode === "light");
const DARK_THEMES = APP_THEMES.filter((theme) => theme.mode === "dark");

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

  // Map/header popovers open above or below the chip — tip on the opposite side.
  const tipPlacement = variant === "header" || variant === "map" ? "bottom" : "left";

  if (variant === "inline") {
    return (
      <div className="lc-bg-palette lc-bg-palette-inline" role="group" aria-label="Theme">
        <span className="lc-bg-palette-label">Theme</span>
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

  const popoverClass =
    variant === "header"
      ? "lc-palette-popover lc-palette-popover-header"
      : variant === "map"
        ? "lc-palette-popover lc-palette-popover-map"
        : "lc-palette-popover";

  return (
    <div
      ref={rootRef}
      className={`lc-palette-compact${variant === "header" ? " lc-palette-header" : ""}${variant === "map" ? " lc-palette-map" : ""}`}
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
        data-tip="Board and UI theme"
        data-tip-placement={tipPlacement}
        aria-label="Theme"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {variant === "header" && (
          <>
            <span className="lc-palette-chip" style={{ background: current.background }} aria-hidden />
            Theme
          </>
        )}
        {variant === "map" && (
          <span className="lc-palette-chip" style={{ background: current.background }} aria-hidden />
        )}
      </button>
      {open && (
        <div className={popoverClass} role="listbox" aria-label="Theme">
          {variant === "map" ? (
            <div className="lc-palette-grouped">
              <ThemeGroup
                label="Light"
                themes={LIGHT_THEMES}
                themeId={themeId}
                onPick={(id) => {
                  onPick(id);
                  setOpen(false);
                }}
                tipPlacement={tipPlacement}
              />
              <ThemeGroup
                label="Dark"
                themes={DARK_THEMES}
                themeId={themeId}
                onPick={(id) => {
                  onPick(id);
                  setOpen(false);
                }}
                tipPlacement={tipPlacement}
              />
            </div>
          ) : (
            <div className="lc-palette-grid">
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
      )}
    </div>
  );
}

function ThemeGroup({
  label,
  themes,
  themeId,
  onPick,
  tipPlacement,
}: {
  label: string;
  themes: AppTheme[];
  themeId: string;
  onPick: (id: string) => void;
  tipPlacement: "top" | "left" | "bottom";
}) {
  return (
    <div className="lc-palette-group">
      <span className="lc-palette-group-label">{label}</span>
      <div className="lc-palette-group-swatches">
        {themes.map((theme) => (
          <Swatch
            key={theme.id}
            theme={theme}
            active={theme.id === themeId}
            onPick={onPick}
            tipPlacement={tipPlacement}
          />
        ))}
      </div>
    </div>
  );
}

function Swatch({
  theme,
  active,
  onPick,
  tipPlacement,
}: {
  theme: AppTheme;
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
