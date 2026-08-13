/**
 * 1D preset sheet — morphs out of a held wheel wedge.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { HoldButton } from "../components/HoldButton";
import { MorphBar } from "../components/MorphBar";
import { StraightIcon } from "../components/MarkToolIcons";
import { ColorRadial } from "./ColorRadial";
import { InkFullnessSlider } from "./InkFullnessSlider";
import { PressureSensitiveToggle } from "./PressureSensitiveToggle";
import { StrokeSizeSlider } from "./StrokeSizeSlider";
import { applyInkOp, ERASER_WIDTH_MAX } from "./rasterInk";
import type { InkHandedness } from "../util/inkHandedness";
import { testStripDrawOp } from "../util/inkPresetStrip";
import {
  isEraserWedge,
  liveDrawSnapshot,
  liveEraserSnapshot,
  type InkDrawSnapshot,
  type InkPresetKind,
  type InkWedgeSnapshot,
} from "../util/inkToolPresets";
import {
  inkBoldnessFromPercent,
  inkBoldnessToPercent,
} from "../util/inkBoldnessPref";
import {
  pressureClipFromPercent,
  pressureClipToPercent,
} from "../util/inkPressureClip";
import {
  smoothingFromPercent,
  smoothingToPercent,
  type InkSmoothingMode,
} from "../util/inkSmoothingPref";
import {
  speedBlotBlendFromPercent,
  speedBlotBlendToPercent,
  speedInkFromPercent,
  speedInkToPercent,
} from "../util/inkSpeedPref";

const PRESSURE_CLIP_STEPS = [30, 40, 50, 60, 70, 80, 90, 100] as const;

function paintStrip(
  canvas: HTMLCanvasElement | null,
  kind: InkPresetKind,
  snap: InkWedgeSnapshot,
): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (kind === "eraser" && isEraserWedge(snap)) {
    paintEraserDot(canvas, ctx, snap.eraserWidth);
    return;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (canvas.width !== 468 || canvas.height !== 88) {
    canvas.width = 468;
    canvas.height = 88;
  }
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--paper") || "#fdf6e3";
  ctx.fillRect(0, 0, w, h);
  const op = testStripDrawOp(kind, snap);
  if (!op) return;
  ctx.save();
  applyInkOp(ctx, op, 1);
  ctx.restore();
}

function paintEraserDot(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  eraserWidth: number,
): void {
  const cssW = Math.max(1, canvas.clientWidth || canvas.width);
  const cssH = Math.max(1, canvas.clientHeight || canvas.height);
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--paper") || "#fdf6e3";
  ctx.fillRect(0, 0, cssW, cssH);
  const maxD = Math.max(8, cssH - 16);
  const t = Math.min(1, Math.max(0, eraserWidth / ERASER_WIDTH_MAX));
  const r = Math.max(3, (t * maxD) / 2);
  ctx.beginPath();
  ctx.arc(cssW / 2, cssH / 2, maxD / 2, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(190, 24, 93, 0.28)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cssW / 2, cssH / 2, r, 0, Math.PI * 2);
  ctx.fillStyle = "#f9a8d4";
  ctx.strokeStyle = "#be185d";
  ctx.lineWidth = 1.35;
  ctx.fill();
  ctx.stroke();
}

export interface InkPresetEditorProps {
  kind: InkPresetKind;
  index: number;
  initial: InkWedgeSnapshot | null;
  /** Empty custom slot starts from Global, not whatever is live. */
  fallback?: InkWedgeSnapshot | null;
  from: DOMRect;
  inkPalette: readonly string[];
  inkColor: string;
  handedness: InkHandedness;
  onEditInkColor?: (index: number, color: string) => void;
  onCycleNext?: () => void;
  onCyclePrev?: () => void;
  onClose: () => void;
  onSave: (snap: InkWedgeSnapshot) => void;
  onDuplicate: (snap: InkWedgeSnapshot) => void;
}

export function InkPresetEditor({
  kind,
  index,
  initial,
  fallback,
  from,
  inkPalette,
  inkColor,
  handedness,
  onEditInkColor,
  onCycleNext,
  onCyclePrev,
  onClose,
  onSave,
  onDuplicate,
}: InkPresetEditorProps) {
  const seed = useMemo(() => {
    if (initial) return initial;
    if (fallback) return { ...fallback, name: "Preset" };
    return kind === "eraser" ? liveEraserSnapshot("Preset") : liveDrawSnapshot("Preset");
  }, [fallback, initial, kind]);
  const [draft, setDraft] = useState<InkWedgeSnapshot>(seed);
  const [name, setName] = useState(seed.name);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    setDraft({ ...seed, name });
  }, [seed, name]);

  const close = () => {
    setClosing(true);
    window.setTimeout(onClose, 220);
  };

  const named = { ...draft, name: name.trim() || seed.name };
  const draw = !isEraserWedge(named);
  const paletteSig = inkPalette.join("|");
  const lastPaletteSigRef = useRef(paletteSig);
  useEffect(() => {
    const sig = inkPalette.join("|");
    if (lastPaletteSigRef.current === sig) return;
    lastPaletteSigRef.current = sig;
    setDraft((prev) => {
      if (isEraserWedge(prev)) return prev;
      if (!inkColor || prev.colour === inkColor) return prev;
      return { ...prev, colour: inkColor };
    });
  }, [inkColor, inkPalette]);

  return createPortal(
    <div className="lc-preset-sheet-layer" onPointerDown={close}>
      <div
        className={closing ? "lc-preset-sheet is-closing" : "lc-preset-sheet is-open"}
        style={{
          ["--lc-morph-x" as string]: `${from.left + from.width / 2}px`,
          ["--lc-morph-y" as string]: `${from.top + from.height / 2}px`,
        }}
        role="dialog"
        aria-label="Preset editor"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="lc-preset-sheet-head">
          <span
            className="lc-preset-sheet-swatch"
            style={{
              background:
                kind === "eraser" && isEraserWedge(named)
                  ? "#f9a8d4"
                  : !isEraserWedge(named)
                    ? named.colour
                    : inkColor,
            }}
          />
          <input
            className="lc-preset-sheet-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Preset name"
          />
          <span className="lc-preset-sheet-meta">
            {kind.toUpperCase()} WHEEL · SLOT {index + 1}
          </span>
          <div className="lc-preset-sheet-actions">
            <HoldButton
              label="Duplicate"
              ariaLabel="Copy this preset into an empty slot"
              onConfirm={() => onDuplicate(named)}
            />
            <HoldButton
              label="Save"
              className="lc-preset-sheet-save"
              onConfirm={() => onSave(named)}
            />
          </div>
        </header>

        <MorphBar active="body" axis="height" className="lc-preset-sheet-morph">
          <div data-morph-id="body">
            <section className="lc-preset-sheet-strip">
              <TestStrip kind={kind} snap={named} />
            </section>

            <div className={draw ? "lc-preset-sheet-cols" : "lc-preset-sheet-cols is-single"}>
              <div className="lc-preset-sheet-side">
                {kind === "eraser" && isEraserWedge(named) ? (
                  <>
                    <div className="lc-preset-sheet-draw">
                      <StrokeSizeSlider
                        value={named.eraserWidth}
                        onChange={(width) => setDraft({ ...named, eraserWidth: width })}
                        label="Eraser size"
                        eraser
                      />
                    </div>
                    <SettingsBlock
                      title="Eraser"
                      hint={
                        <>
                          <strong>Rub out</strong> clears whatever the ring covers, so a small
                          eraser takes a bite out of the side of a letter and leaves the rest —
                          the way a real one does. <strong>Whole strokes</strong> removes any
                          stroke you touch, which is what you want for pulling one wrong line out
                          of a diagram. Saved on this device only.
                        </>
                      }
                    >
                      <SettingsChoice
                        label="What the eraser removes"
                        value={named.partialErase}
                        options={[
                          [true, "Rub out"],
                          [false, "Whole strokes"],
                        ]}
                        onChange={(partialErase) => setDraft({ ...named, partialErase })}
                      />
                    </SettingsBlock>
                  </>
                ) : (
                  draw && <DrawKnobs snap={named} onChange={setDraft} />
                )}
                {draw && (
                  <div className="lc-preset-sheet-color">
                    <ColorRadial
                      colors={inkPalette}
                      value={named.colour}
                      onPick={(colour) => setDraft({ ...named, colour })}
                      onEditColor={(slot, colour) => {
                        onEditInkColor?.(slot, colour);
                        setDraft({ ...named, colour });
                      }}
                      onCycleNext={onCycleNext}
                      onCyclePrev={onCyclePrev}
                      handedness={handedness}
                      embedded
                    />
                  </div>
                )}
              </div>
              {draw && (
                <div className="lc-preset-sheet-physics">
                  <PhysicsKnobs snap={named} onChange={setDraft} />
                </div>
              )}
            </div>
          </div>
        </MorphBar>
      </div>
    </div>,
    document.body,
  );
}

function TestStrip({ kind, snap }: { kind: InkPresetKind; snap: InkWedgeSnapshot }) {
  return (
    <canvas
      className="lc-preset-strip-canvas"
      width={468}
      height={88}
      ref={(node) => paintStrip(node, kind, snap)}
      aria-hidden
    />
  );
}

function DrawKnobs({
  snap,
  onChange,
}: {
  snap: InkDrawSnapshot;
  onChange: (next: InkDrawSnapshot) => void;
}) {
  return (
    <div className="lc-preset-sheet-draw">
      <StrokeSizeSlider
        value={snap.width}
        onChange={(width) => onChange({ ...snap, width })}
        label="Nib size"
      />
      <InkFullnessSlider
        value={snap.fullness}
        onChange={(fullness) => onChange({ ...snap, fullness })}
      />
      <PressureSensitiveToggle
        enabled={snap.pressureSensitive}
        onChange={(pressureSensitive) => onChange({ ...snap, pressureSensitive })}
      />
      <button
        type="button"
        className={
          snap.straightInk
            ? "lc-tool lc-tool-mini lc-tool-active"
            : "lc-tool lc-tool-mini"
        }
        aria-label="Straight stroke"
        aria-pressed={snap.straightInk}
        onClick={() => onChange({ ...snap, straightInk: !snap.straightInk })}
      >
        <StraightIcon />
      </button>
    </div>
  );
}

function PhysicsKnobs({
  snap,
  onChange,
}: {
  snap: InkDrawSnapshot;
  onChange: (next: InkDrawSnapshot) => void;
}) {
  const speedPct = speedInkToPercent(snap.speed);
  const smoothPct = smoothingToPercent(snap.smoothing);
  const clipPct = pressureClipToPercent(snap.pressureClip);
  return (
    <>
      <SettingsBlock
        title="Pressure clip"
        hint={
          <>
            How hard you press before the pen reads as &ldquo;full&rdquo; pressure. Lower
            values make light strokes reach max ink sooner — useful on a stiff nib or a tablet
            that reports low pressure. Saved on this device only.
          </>
        }
      >
        <div
          className="lc-settings-choice lc-settings-choice-compact"
          role="radiogroup"
          aria-label="Pressure clip"
        >
          {PRESSURE_CLIP_STEPS.map((percent) => (
            <button
              key={percent}
              type="button"
              role="radio"
              aria-checked={clipPct === percent}
              className={
                clipPct === percent
                  ? "lc-settings-choice-option is-active"
                  : "lc-settings-choice-option"
              }
              onClick={() =>
                onChange({ ...snap, pressureClip: pressureClipFromPercent(percent) })
              }
            >
              <strong>{percent}%</strong>
            </button>
          ))}
        </div>
      </SettingsBlock>

      <SettingsBlock
        title="Speed ink"
        hint={
          <>
            Let the pace of your hand change what the nib leaves behind — ink pools
            where you dwell and thins out where you run, the way it does on paper.
            Off leaves the stroke the same weight however fast you write. Saved on
            this device only.
          </>
        }
      >
        <SettingsRange
          label="Speed ink"
          min={0}
          max={100}
          step={5}
          value={speedPct}
          display={speedPct === 0 ? "Off" : `${speedPct}%`}
          onChange={(n) => onChange({ ...snap, speed: speedInkFromPercent(n) })}
        />
      </SettingsBlock>

      {speedPct > 0 && (
        <SettingsBlock
          title="Speed blot blend"
          hint={
            <>
              Soft rim on the dwell pool and how fast it spreads from a small
              core out to the tip — not a halo past the stroke. 0% keeps a hard
              expanding disc; 100% softens the rim and grows faster. Saved on
              this device only.
            </>
          }
        >
          <SettingsRange
            label="Speed blot blend"
            min={0}
            max={100}
            step={5}
            value={speedBlotBlendToPercent(snap.blot)}
            onChange={(n) => onChange({ ...snap, blot: speedBlotBlendFromPercent(n) })}
          />
        </SettingsBlock>
      )}

      <SettingsBlock
        title="Ink boldness"
        hint={
          <>
            Boost stroke opacity to compensate for softer speed blot blend —
            100% is the current alpha, 0% is transparent, 300% is three
            times as dark (clamped to opaque at paint). Saved on this device
            only.
          </>
        }
      >
        <SettingsRange
          label="Ink boldness"
          min={0}
          max={300}
          step={5}
          value={inkBoldnessToPercent(snap.boldness)}
          onChange={(n) => onChange({ ...snap, boldness: inkBoldnessFromPercent(n) })}
        />
      </SettingsBlock>

      <SettingsBlock
        title="Stroke smoothing"
        hint={
          <>
            How much of the shake to take out of a pen stroke. Higher steadies a
            shaky hand; lower keeps every kink you actually drew. Saved on this
            device only.
          </>
        }
      >
        <SettingsRange
          label="Stroke smoothing"
          min={0}
          max={100}
          step={5}
          value={smoothPct}
          display={smoothPct === 0 ? "Off" : `${smoothPct}%`}
          onChange={(n) => onChange({ ...snap, smoothing: smoothingFromPercent(n) })}
        />
      </SettingsBlock>

      {smoothPct > 0 && (
        <>
          <p className="lc-settings-hint">
            When it is applied. <strong>On the lift</strong> tidies the stroke once
            you finish it, so the ink is always exactly under the nib as you write.
            <strong> While you write</strong> keeps re-smoothing the stroke under
            your hand — earlier bends tidy before you lift, and the tip still
            tracks the pen. Changes apply immediately.
          </p>
          <SettingsChoice
            label="When to smooth"
            value={snap.smoothingMode}
            options={
              [
                ["lift", "On the lift"],
                ["live", "While you write"],
              ] as Array<[InkSmoothingMode, string]>
            }
            onChange={(smoothingMode) => onChange({ ...snap, smoothingMode })}
          />
        </>
      )}
    </>
  );
}

function SettingsBlock({
  title,
  hint,
  children,
}: {
  title: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="lc-preset-sheet-field">
      <div className="lc-settings-subhead">{title}</div>
      <p className="lc-settings-hint">{hint}</p>
      {children}
    </div>
  );
}

function SettingsRange({
  label,
  min,
  max,
  step,
  value,
  display,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display?: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="lc-settings-slider">
      <input
        type="range"
        className="lc-settings-slider-input"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="lc-settings-slider-value">{display ?? `${value}%`}</span>
    </div>
  );
}

function SettingsChoice<T extends string | boolean>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (next: T) => void;
}) {
  return (
    <div
      className="lc-settings-choice lc-settings-choice-compact"
      role="radiogroup"
      aria-label={label}
    >
      {options.map(([option, text]) => (
        <button
          key={text}
          type="button"
          role="radio"
          aria-checked={value === option}
          className={
            value === option ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"
          }
          onClick={() => onChange(option)}
        >
          <strong>{text}</strong>
        </button>
      ))}
    </div>
  );
}
