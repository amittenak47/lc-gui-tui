/**
 * Draft colour editor for a wheel slot.
 *
 * Replaces `<input type="color">`, which writes on every drag and has no
 * confirm on this WebView. Check commits; X (or Escape) discards.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import {
  clampByte,
  hexToHsv,
  hsvToHex,
  hsvToRgb,
  rgbToHex,
  type Hsv,
} from "./colorSlot";

export interface ColorSlotEditorProps {
  color: string;
  /** Viewport-fixed origin — typically the wheel centre. */
  anchor: { x: number; y: number };
  onConfirm: (color: string) => void;
  onDiscard: () => void;
}

type ChannelMode = "rgb" | "hex";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 10.5 8.2 15 16 5.5"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 20 20" width="13" height="13" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        d="M5 5l10 10M15 5 5 15"
      />
    </svg>
  );
}

function EyedropIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.5 5.5 18.5 9.5M16.5 3.5l4 4-11 11H5.5v-4.1Z"
      />
    </svg>
  );
}

export function ColorSlotEditor({ color, anchor, onConfirm, onDiscard }: ColorSlotEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(color) ?? { h: 0, s: 0, v: 0 });
  const [mode, setMode] = useState<ChannelMode>("rgb");
  const hex = hsvToHex(hsv);
  const rgb = hsvToRgb(hsv);
  const hueFill = `hsl(${hsv.h}, 100%, 50%)`;

  const setFromEvent = useCallback((event: ReactPointerEvent<HTMLDivElement>, kind: "sv" | "hue") => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (kind === "hue") {
      const t = clamp01((event.clientX - rect.left) / Math.max(1, rect.width));
      setHsv((current) => ({ ...current, h: t * 360 }));
      return;
    }
    setHsv((current) => ({
      ...current,
      s: clamp01((event.clientX - rect.left) / Math.max(1, rect.width)),
      v: 1 - clamp01((event.clientY - rect.top) / Math.max(1, rect.height)),
    }));
  }, []);

  const dragKind = useRef<"sv" | "hue" | null>(null);
  const onPadDown = (kind: "sv" | "hue") => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragKind.current = kind;
    event.currentTarget.setPointerCapture(event.pointerId);
    setFromEvent(event, kind);
  };
  const onPadMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragKind.current) return;
    setFromEvent(event, dragKind.current);
  };
  const onPadUp = () => {
    dragKind.current = null;
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDiscard();
      }
      if (event.key === "Enter") {
        event.preventDefault();
        onConfirm(hex);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hex, onConfirm, onDiscard]);

  const eyedropOpen = useRef(false);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (eyedropOpen.current) return;
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      onDiscard();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onDiscard]);

  const pickEye = async () => {
    const Ctor = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } })
      .EyeDropper;
    if (!Ctor) return;
    eyedropOpen.current = true;
    try {
      const result = await new Ctor().open();
      const next = hexToHsv(result.sRGBHex);
      if (next) setHsv(next);
    } catch {
      /* user cancelled the dropper */
    } finally {
      eyedropOpen.current = false;
    }
  };

  const canDrop = typeof window !== "undefined" && "EyeDropper" in window;
  const left = Math.min(window.innerWidth - 236, Math.max(8, anchor.x + 86));
  const top = Math.min(window.innerHeight - 268, Math.max(8, anchor.y - 120));

  return createPortal(
    <div
      ref={rootRef}
      className="lc-color-slot-editor"
      role="dialog"
      aria-label="Edit ink colour"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className="lc-color-slot-sv"
        style={{
          backgroundImage: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueFill})`,
        }}
        onPointerDown={onPadDown("sv")}
        onPointerMove={onPadMove}
        onPointerUp={onPadUp}
        onPointerCancel={onPadUp}
      >
        <span
          className="lc-color-slot-knob"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>
      <div className="lc-color-slot-row">
        {canDrop ? (
          <button type="button" className="lc-color-slot-icon" aria-label="Pick from screen" onClick={() => void pickEye()}>
            <EyedropIcon />
          </button>
        ) : null}
        <span className="lc-color-slot-preview" style={{ background: hex }} aria-hidden />
        <div
          className="lc-color-slot-hue"
          onPointerDown={onPadDown("hue")}
          onPointerMove={onPadMove}
          onPointerUp={onPadUp}
          onPointerCancel={onPadUp}
        >
          <span className="lc-color-slot-hue-knob" style={{ left: `${(hsv.h / 360) * 100}%` }} />
        </div>
      </div>
      {mode === "rgb" ? (
        <div className="lc-color-slot-channels">
          {(["r", "g", "b"] as const).map((key) => (
            <label key={key}>
              <input
                type="number"
                min={0}
                max={255}
                value={rgb[key]}
                onChange={(event) => {
                  const next = { ...rgb, [key]: clampByte(Number(event.target.value)) };
                  const converted = hexToHsv(rgbToHex(next));
                  if (!converted) return;
                  setHsv(converted.s < 0.01 ? { ...converted, h: hsv.h } : converted);
                }}
              />
              <span>{key.toUpperCase()}</span>
            </label>
          ))}
          <button
            type="button"
            className="lc-color-slot-mode"
            aria-label="Switch to hex"
            onClick={() => setMode("hex")}
          >
            ↕
          </button>
        </div>
      ) : (
        <div className="lc-color-slot-channels">
          <label className="lc-color-slot-hex">
            <input
              value={hex}
              spellCheck={false}
              onChange={(event) => {
                const next = hexToHsv(event.target.value);
                if (next) setHsv(next);
              }}
            />
            <span>HEX</span>
          </label>
          <button
            type="button"
            className="lc-color-slot-mode"
            aria-label="Switch to RGB"
            onClick={() => setMode("rgb")}
          >
            ↕
          </button>
        </div>
      )}
      <div className="lc-color-slot-actions">
        <button
          type="button"
          className="lc-color-slot-go"
          aria-label="Use this colour"
          title="Use this colour"
          onClick={() => onConfirm(hex)}
        >
          <CheckIcon />
        </button>
        <button
          type="button"
          className="lc-color-slot-stop"
          aria-label="Discard colour"
          title="Discard"
          onClick={onDiscard}
        >
          <XIcon />
        </button>
      </div>
    </div>,
    document.body,
  );
}
