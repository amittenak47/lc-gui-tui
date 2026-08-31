/**
 * 1D preset sheet — morphs out of a held wheel wedge.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { HoldButton } from "../components/HoldButton";
import { MorphBar } from "../components/MorphBar";
import { StraightIcon, PinkEraserIcon } from "../components/MarkToolIcons";
import { ColorRadial } from "./ColorRadial";
import { InkFullnessSlider } from "./InkFullnessSlider";
import { PressureSensitiveToggle } from "./PressureSensitiveToggle";
import { StrokeSizeSlider } from "./StrokeSizeSlider";
import { smoothInkPoints } from "./inkSmoothing";
import {
  applyInkOp,
  ERASER_WIDTH_MAX,
  inkLineWidth,
  inkSlowness,
  INK_HOLD_STILL_PX,
  INK_SPEED_NEUTRAL_PX_MS,
  blotGrowTFromTicks,
  blotTicksToFull,
  pointerPressure,
  smoothPressure,
  smoothSpeed,
  type InkDrawOp,
  type ScenePoint,
} from "./rasterInk";
import type { InkHandedness } from "../util/inkHandedness";
import { drawOpFromSnap, testStripDrawOp } from "../util/inkPresetStrip";
import {
  defaultDrawSnapshot,
  defaultEraserSnapshot,
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
  grainFromPercent,
  grainToPercent,
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
  const [livePreview, setLivePreview] = useState(false);
  const [livePadGen, setLivePadGen] = useState(0);
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
              label="Reset"
              ariaLabel="Reset this preset to the stock pen"
              onConfirm={() => {
                setDraft(
                  kind === "eraser"
                    ? defaultEraserSnapshot(name.trim() || seed.name)
                    : defaultDrawSnapshot(name.trim() || seed.name),
                );
                setLivePadGen((n) => n + 1);
              }}
            />
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
              <div className="lc-preset-sheet-field">
                <div
                  className="lc-preset-preview-toggle"
                  role="radiogroup"
                  aria-label="Preview mode"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!livePreview}
                    className={!livePreview ? "is-active" : undefined}
                    onClick={() => setLivePreview(false)}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={livePreview}
                    className={livePreview ? "is-active" : undefined}
                    onClick={() => setLivePreview(true)}
                  >
                    Live
                  </button>
                </div>
                <p className="lc-settings-hint">
                  {livePreview
                    ? "Draw here with this preset before you Save. Switching Live off, or Erase, clears the pad."
                    : "How this preset draws. Updates as you change the knobs."}
                </p>
                <div className="lc-preset-preview-stage">
                  {livePreview ? (
                    <>
                      <LivePad key={livePadGen} kind={kind} snap={named} />
                      <button
                        type="button"
                        className="lc-preset-preview-erase"
                        aria-label="Erase preview"
                        onClick={() => setLivePadGen((n) => n + 1)}
                      >
                        <PinkEraserIcon size={16} />
                      </button>
                    </>
                  ) : (
                    <TestStrip kind={kind} snap={named} />
                  )}
                </div>
              </div>
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

function fillPreviewPaper(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
): void {
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--paper") || "#fdf6e3";
  ctx.fillRect(0, 0, cssW, cssH);
}

function LivePad({ kind, snap }: { kind: InkPresetKind; snap: InkWedgeSnapshot }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const kindRef = useRef(kind);
  const snapRef = useRef(snap);
  kindRef.current = kind;
  snapRef.current = snap;
  const strokesRef = useRef<InkDrawOp[]>([]);
  const livePtsRef = useRef<ScenePoint[] | null>(null);
  const eraserTipRef = useRef<{ x: number; y: number } | null>(null);
  const pressureEmaRef = useRef(0);
  const speedEmaRef = useRef(0);
  const lastSampleRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const dprRef = useRef(1);
  const paintFnRef = useRef<() => void>(() => {});
  const drawingRef = useRef(false);
  const dwellCountRef = useRef(0);
  const blotTipGrowRef = useRef(0);
  const lastMoveWallRef = useRef(0);
  const dwellTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const size = () => {
      const cssW = Math.max(1, canvas.clientWidth || 468);
      const cssH = Math.max(1, canvas.clientHeight || 88);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      dprRef.current = dpr;
      const bw = Math.round(cssW * dpr);
      const bh = Math.round(cssH * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      return { cssW, cssH, dpr };
    };

    const paint = () => {
      const { cssW, cssH, dpr } = size();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      fillPreviewPaper(canvas, ctx, cssW, cssH);
      const current = snapRef.current;
      if (kindRef.current === "eraser" && isEraserWedge(current)) {
        const tip = eraserTipRef.current ?? { x: cssW / 2, y: cssH / 2 };
        const maxD = Math.max(8, cssH - 16);
        const t = Math.min(1, Math.max(0, current.eraserWidth / ERASER_WIDTH_MAX));
        const r = Math.max(3, (t * maxD) / 2);
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, maxD / 2, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(190, 24, 93, 0.28)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#f9a8d4";
        ctx.strokeStyle = "#be185d";
        ctx.lineWidth = 1.35;
        ctx.fill();
        ctx.stroke();
        return;
      }
      for (const op of strokesRef.current) {
        applyInkOp(ctx, op, dpr);
      }
      const livePts = livePtsRef.current;
      if (!livePts || livePts.length === 0) return;
      const liveSnap = snapRef.current;
      if (isEraserWedge(liveSnap)) return;
      const smoothing = liveSnap.smoothing;
      const smoothingMode = liveSnap.smoothingMode;
      const points =
        smoothingMode === "live" && smoothing > 0
          ? smoothInkPoints(livePts, smoothing, inkLineWidth(liveSnap.width, 0, false))
          : livePts;
      const op = drawOpFromSnap(kindRef.current, liveSnap, points);
      if (op) {
        if (blotTipGrowRef.current > 0) op.blotTipGrow = blotTipGrowRef.current;
        applyInkOp(ctx, op, dpr);
      }
    };
    paintFnRef.current = paint;

    const pointFrom = (event: PointerEvent): ScenePoint => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const t = event.timeStamp || performance.now();
      const raw = pointerPressure(event.pressure, event.pointerType);
      const prev = pressureEmaRef.current;
      const pressure = raw < 0 ? raw : smoothPressure(prev || raw, raw);
      if (raw >= 0) pressureEmaRef.current = pressure;

      const current = snapRef.current;
      const paced =
        !isEraserWedge(current) &&
        (current.speed > 0 || current.blot > 0 || current.fade > 0);
      let slowness: number | undefined;
      if (paced) {
        const last = lastSampleRef.current;
        if (last && t > last.t) {
          const dist = Math.hypot(x - last.x, y - last.y);
          speedEmaRef.current = smoothSpeed(speedEmaRef.current, dist / (t - last.t));
        }
        slowness = inkSlowness(speedEmaRef.current);
      }
      lastSampleRef.current = { x, y, t };
      return { x, y, pressure, ...(slowness != null ? { slowness } : {}) };
    };

    const clearDwell = () => {
      if (dwellTimerRef.current !== null) {
        clearInterval(dwellTimerRef.current);
        dwellTimerRef.current = null;
      }
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType !== "pen") return;
      event.preventDefault();
      event.stopPropagation();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* capture is best-effort */
      }
      const current = snapRef.current;
      pressureEmaRef.current = 0;
      speedEmaRef.current =
        !isEraserWedge(current) &&
        (current.speed > 0 || current.blot > 0 || current.fade > 0)
          ? INK_SPEED_NEUTRAL_PX_MS
          : 0;
      lastSampleRef.current = null;
      dwellCountRef.current = 0;
      blotTipGrowRef.current = 0;
      lastMoveWallRef.current = performance.now();
      drawingRef.current = true;
      const pt = pointFrom(event);
      lastPosRef.current = { x: pt.x, y: pt.y };
      if (kindRef.current === "eraser") {
        eraserTipRef.current = { x: pt.x, y: pt.y };
        livePtsRef.current = null;
      } else {
        livePtsRef.current = [pt];
        if (!isEraserWedge(current) && (current.speed > 0 || current.blot > 0 || current.fade > 0)) {
          clearDwell();
          dwellTimerRef.current = setInterval(() => {
            if (!drawingRef.current) return;
            const live = livePtsRef.current;
            if (!live || live.length === 0) return;
            const snap = snapRef.current;
            if (isEraserWedge(snap) || snap.blot <= 0) return;
            if (performance.now() - lastMoveWallRef.current < 60) return;
            if (dwellCountRef.current >= blotTicksToFull(snap.blot)) return;
            dwellCountRef.current++;
            blotTipGrowRef.current = blotGrowTFromTicks(dwellCountRef.current, snap.blot);
            speedEmaRef.current = smoothSpeed(speedEmaRef.current, 0);
            const tip = live[live.length - 1];
            if (tip) tip.slowness = inkSlowness(speedEmaRef.current);
            paint();
          }, 32);
        }
      }
      paint();
    };
    const onMove = (event: PointerEvent) => {
      if (kindRef.current === "eraser") {
        if (eraserTipRef.current == null && (event.buttons & 1) === 0) return;
        const pt = pointFrom(event);
        eraserTipRef.current = { x: pt.x, y: pt.y };
        paint();
        return;
      }
      if (!livePtsRef.current) return;
      const pt = pointFrom(event);
      const prev = lastPosRef.current;
      if (prev && Math.hypot(pt.x - prev.x, pt.y - prev.y) > INK_HOLD_STILL_PX) {
        lastMoveWallRef.current = performance.now();
        dwellCountRef.current = 0;
        blotTipGrowRef.current = 0;
      }
      lastPosRef.current = { x: pt.x, y: pt.y };
      livePtsRef.current.push(pt);
      paint();
    };
    const onUp = (event: PointerEvent) => {
      drawingRef.current = false;
      clearDwell();
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      if (kindRef.current === "eraser") {
        paint();
        lastSampleRef.current = null;
        return;
      }
      const livePts = livePtsRef.current;
      if (!livePts) return;
      const liveSnap = snapRef.current;
      let points = livePts;
      if (!isEraserWedge(liveSnap) && points.length > 1 && liveSnap.smoothing > 0) {
        points = smoothInkPoints(
          points,
          liveSnap.smoothing,
          inkLineWidth(liveSnap.width, 0, false),
        );
      }
      const op = drawOpFromSnap(kindRef.current, liveSnap, points);
      if (op && points.length > 0) {
        if (blotTipGrowRef.current > 0) op.blotTipGrow = blotTipGrowRef.current;
        strokesRef.current.push(op);
      }
      livePtsRef.current = null;
      lastSampleRef.current = null;
      lastPosRef.current = null;
      blotTipGrowRef.current = 0;
      paint();
    };

    size();
    paint();
    const ro = new ResizeObserver(() => paint());
    ro.observe(canvas);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
      drawingRef.current = false;
      clearDwell();
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, []);

  useEffect(() => {
    paintFnRef.current();
  }, [snap]);

  return (
    <canvas
      ref={canvasRef}
      className="lc-preset-strip-canvas is-live"
      width={468}
      height={88}
      aria-label="Live preset preview"
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
            fattens, speed up and it thins. Speed blot and Speed fade are
            separate and work even when this is Off. Saved on this device only.
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

      <SettingsBlock
        title="Grain"
        hint={
          <>
            Nib material. Off is a hard felt-tip. Turn it up for a fine paper
            tooth — short fibres, varied transparency, one consistent heading.
            Speed blot can still pool that disc if you hold. Saved on this
            device only.
          </>
        }
      >
        <SettingsRange
          label="Grain"
          min={0}
          max={100}
          step={5}
          value={grainToPercent(snap.grain ?? 0)}
          display={grainToPercent(snap.grain ?? 0) === 0 ? "Off" : `${grainToPercent(snap.grain ?? 0)}%`}
          onChange={(n) => onChange({ ...snap, grain: grainFromPercent(n) })}
        />
      </SettingsBlock>

      <SettingsBlock
        title="Speed blot"
        hint={
          <>
            Hold to pool a richer, slower blot at the nib — even with Speed
            ink off. Off stays nib-sized. 100% still takes about a second of
            holding to reach a modest pool past the stroke, denser than the
            trail not paler. Saved on this device only.
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
