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
  speedBodyAccentFromPercent,
  speedBodyAccentToPercent,
  speedFadeFromPercent,
  speedFadeToPercent,
  speedInkFromPercent,
  speedInkToPercent,
} from "../util/inkSpeedPref";

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
  onClose: (reason: "back" | "dismiss") => void;
  /** Wheel remounts under the sheet so the morph-out lands on the wedge. */
  onBackReveal?: () => void;
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
  onBackReveal,
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
  const closeReasonRef = useRef<"back" | "dismiss">("dismiss");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onBackRevealRef = useRef(onBackReveal);
  onBackRevealRef.current = onBackReveal;

  useEffect(() => {
    setDraft({ ...seed, name });
  }, [seed, name]);

  const close = (reason: "back" | "dismiss" = "dismiss") => {
    if (closing) return;
    closeReasonRef.current = reason;
    if (reason === "back") onBackRevealRef.current?.();
    setClosing(true);
    window.setTimeout(() => onCloseRef.current(closeReasonRef.current), 220);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close("back");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // close is stable enough via closing guard + refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

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
    <div className="lc-preset-sheet-layer" onPointerDown={() => close("dismiss")}>
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
          <button
            type="button"
            className="lc-preset-sheet-back"
            onClick={() => close("back")}
          >
            Back
          </button>
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

        <div className="lc-preset-sheet-body lc-scroll-pane">
          <MorphBar active="body" axis="height" className="lc-preset-sheet-morph">
          <div data-morph-id="body">
            <section className="lc-preset-sheet-strip">
              <SettingsBlock
                title="Preview"
                hint="How this preset draws. Updates as you change the knobs."
              >
                <TestStrip kind={kind} snap={named} />
              </SettingsBlock>
            </section>

            <div className={draw ? "lc-preset-sheet-cols" : "lc-preset-sheet-cols is-single"}>
              <div className="lc-preset-sheet-side">
                {kind === "eraser" && isEraserWedge(named) ? (
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
                    <div className="lc-preset-sheet-draw">
                      <StrokeSizeSlider
                        value={named.eraserWidth}
                        onChange={(width) => setDraft({ ...named, eraserWidth: width })}
                        label="Eraser size"
                        eraser
                      />
                    </div>
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
                ) : (
                  draw && <DrawKnobs snap={named} onChange={setDraft} />
                )}
                {draw && (
                  <SettingsBlock
                    title="Colour"
                    hint={
                      <>
                        Tap a wedge to pick it. Tap the hub to cycle palettes. Hold a wedge
                        to edit that slot. Saved on this device only.
                      </>
                    }
                  >
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
                  </SettingsBlock>
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
    <SettingsBlock
      title="Stroke"
      hint={
        snap.pressureSensitive ? (
          <>
            Pressure is on: how hard you press changes how dark the ink is, not
            how wide. A light touch is paler, a firm press is solid. Ink fullness
            is a flat decay over how far you have written — 100% stays wet,
            0% dries out along the stroke, which is why 100% looks bolder.
            Pressure clip (below) is how hard a press counts as solid. Saved on
            this device only.
          </>
        ) : (
          <>
            Nib width and a straight-stroke lock. The starburst turns on stylus
            pressure: how hard you press then changes darkness, not width. Saved
            on this device only.
          </>
        )
      }
    >
      <div className="lc-preset-sheet-draw">
        <StrokeSizeSlider
          value={snap.width}
          onChange={(width) => onChange({ ...snap, width })}
          label="Nib size"
        />
        <div
          className={
            snap.pressureSensitive ? "lc-ink-fold is-open" : "lc-ink-fold"
          }
        >
          <div className="lc-ink-fold-inner">
            <InkFullnessSlider
              value={snap.fullness}
              onChange={(fullness) => onChange({ ...snap, fullness })}
              enabled={snap.pressureSensitive}
            />
          </div>
        </div>
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
    </SettingsBlock>
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
      {snap.pressureSensitive && (
        <SettingsBlock
          title="Pressure clip"
          hint={
            <>
              How hard a press counts as solid ink — a threshold on darkness,
              not width. 100% means you have to press fully for full opacity;
              30% lets a lighter press look just as dark. Saved on this device
              only.
            </>
          }
        >
          <SettingsRange
            label="Pressure clip"
            min={30}
            max={100}
            step={1}
            value={clipPct}
            onChange={(n) =>
              onChange({ ...snap, pressureClip: pressureClipFromPercent(n) })
            }
          />
        </SettingsBlock>
      )}

      <SettingsBlock
        title="Speed ink"
        hint={
          <>
            Same pen as Off at a normal writing pace: slow down and the line
            fattens, speed up and it thins. Body accent (below) is a modifier
            of this dial. Speed blot and Speed fade are separate and work even
            when this is Off. Saved on this device only.
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
          title="Body accent"
          hint={
            <>
              Strength of the mid-stroke width wiggle while Speed ink is on: a
              bit slow fattens, a bit fast thins. A full stop and a sprint stay
              on the Speed ink line, so this does not blob the endpoints. Off
              leaves Speed ink as the linear rest-to-sprint line. Saved on
              this device only.
            </>
          }
        >
          <SettingsRange
            label="Body accent"
            min={0}
            max={100}
            step={5}
            value={speedBodyAccentToPercent(snap.body ?? 0)}
            display={
              speedBodyAccentToPercent(snap.body ?? 0) === 0
                ? "Off"
                : `${speedBodyAccentToPercent(snap.body ?? 0)}%`
            }
            onChange={(n) =>
              onChange({ ...snap, body: speedBodyAccentFromPercent(n) })
            }
          />
        </SettingsBlock>
      )}

      <SettingsBlock
        title="Speed blot"
        hint={
          <>
            Graphite pencil: overlapping interleaved discs instead of a flat
            stroke. Off keeps a solid ribbon. 100% is the full pencil pool.
            Saved on this device only.
          </>
        }
      >
        <SettingsRange
          label="Speed blot"
          min={0}
          max={100}
          step={5}
          value={speedBlotBlendToPercent(snap.blot)}
          display={speedBlotBlendToPercent(snap.blot) === 0 ? "Off" : `${speedBlotBlendToPercent(snap.blot)}%`}
          onChange={(n) => onChange({ ...snap, blot: speedBlotBlendFromPercent(n) })}
        />
      </SettingsBlock>
      <SettingsBlock
        title="Speed fade"
        hint={
          <>
            A pace gradient: ink pools when you write slowly and goes faint when
            you write fast. Not the same as Ink fullness, which dries by how far
            you have travelled, not how fast. Off keeps full ink. Saved on this
            device only.
          </>
        }
      >
        <SettingsRange
          label="Speed fade"
          min={0}
          max={100}
          step={5}
          value={speedFadeToPercent(snap.fade)}
          display={speedFadeToPercent(snap.fade) === 0 ? "Off" : `${speedFadeToPercent(snap.fade)}%`}
          onChange={(n) => onChange({ ...snap, fade: speedFadeFromPercent(n) })}
        />
      </SettingsBlock>

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
            shaky hand; lower keeps every kink you actually drew. With speed ink
            on, width still tapers along the stroke instead of stepping into
            blocks. Saved on this device only.
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
            When it is applied. <strong>On Lift</strong> tidies the stroke once
            you finish it, so the ink is always exactly under the nib as you write.
            <strong> While Writing</strong> keeps re-smoothing the stroke under
            your hand — earlier bends tidy before you lift, and the tip still
            tracks the pen. Changes apply immediately.
          </p>
          <SettingsChoice
            label="When to smooth"
            value={snap.smoothingMode}
            options={
              [
                ["lift", "On Lift"],
                ["live", "While Writing"],
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
