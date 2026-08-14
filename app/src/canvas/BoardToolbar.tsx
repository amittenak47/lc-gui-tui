/**
 * The board's only chrome for the pen: one floating island at the bottom of the
 * canvas, in the slot the page control used to own.
 *
 * It replaces two things at once — the full-width strip that used to sit across
 * the top of the board, and the near-pen cluster that faded in after every
 * stroke. The strip cost a band of canvas and reflowed the page whenever the
 * active tool changed the row's height; the cluster cost a timer and a DOM
 * write on every stroke end, competing with the ink layer for the same frames.
 * One island, one row, always the same height, is what is left.
 *
 * Everything that is not a tool hides behind a press: the hex hold-cycles
 * shapes / import photo / screencap, colour fans out of one dot
 * ({@link ColorRadial}), pen / highlighter / eraser live on the ink wheel
 * (hold the preset chip).
 *
 * Long-press the grip to undock and drag the island anywhere on the workspace;
 * drop near the bottom dock slot to snap it home with a short settle animation.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { MorphBar } from "../components/MorphBar";
import { HoldButton } from "../components/HoldButton";
import { StraightIcon } from "../components/MarkToolIcons";
import { relativeLuminance } from "../util/footnoteTheme";
import {
  SHAPES,
  SHAPE_GROUPS,
  type ShapeModValue,
  type ShapeStamp,
} from "../templates/shapes";
import { HOLD_MS, LONG_PRESS_MS, WHEEL_OPEN_MS } from "../util/gesture";
import type { InkHandedness } from "../util/inkHandedness";
import {
  clampToBox,
  loadToolbarLayout,
  saveToolbarLayout,
  TOOLBAR_DOCK_SNAP_PX,
  TOOLBAR_LEFT_CHROME_INSET_PX,
  toolbarAxis,
  type ToolbarLayout,
} from "../util/toolbarLayout";
import type { ToolName } from "./BoardHandle";
import { ColorRadial } from "./ColorRadial";
import { FontSizeSlider } from "./FontSizeSlider";
import { inkSwatches } from "./inkColors";
import { InkFullnessSlider } from "./InkFullnessSlider";
import { PressureSensitiveToggle } from "./PressureSensitiveToggle";
import { StrokeSizeSlider } from "./StrokeSizeSlider";

/** Board hole when the desktop coach is open; otherwise the window. */
function boardChromeBox(): { left: number; top: number; right: number; bottom: number } {
  const app = document.querySelector(".lc-app");
  const main = document.querySelector(".lc-main");
  if (
    app instanceof HTMLElement &&
    main instanceof HTMLElement &&
    app.classList.contains("lc-app-agent-open") &&
    !app.classList.contains("lc-mobile")
  ) {
    return main.getBoundingClientRect();
  }
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

function clampFloatingPos(
  x: number,
  y: number,
  width: number,
  height: number,
  extraLeft = 0,
): { x: number; y: number } {
  const box = boardChromeBox();
  return clampToBox(x, y, width, height, { ...box, left: box.left + extraLeft });
}

/** Label ink on a preset-coloured chip — dark on pastels, light on ink. */
function presetChipInk(fill: string): string {
  return relativeLuminance(fill) > 0.55 ? "#1c1917" : "#fafafa";
}

function dockAnchorRect(toolbar: HTMLElement | null): DOMRect | null {
  const dock = toolbar?.closest(".lc-board-dock");
  if (!(dock instanceof HTMLElement)) return null;
  // Prefer the dedicated anchor (sized when the island is floating); fall back
  // to the dock column itself.
  const anchor = dock.querySelector(".lc-toolbar-dock-anchor");
  if (anchor instanceof HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    if (rect.width >= 8 || rect.height >= 8) return rect;
  }
  return dock.getBoundingClientRect();
}

/** Shapes flyout — same menu the ⬡ button opens (includes Text box). */
const SHAPE_TOOLS: Array<{ tool: ToolName; label: string; glyph: string }> = [
  { tool: "rectangle", label: "Square", glyph: "▭" },
  { tool: "ellipse", label: "Circle", glyph: "◯" },
  { tool: "arrow", label: "Arrow", glyph: "↗" },
  { tool: "text", label: "Text box", glyph: "T" },
];

/** Hold-to-fill on the hex cycles this slot; tap uses whatever is showing. */
const SHAPE_SLOTS = ["shapes", "photos", "capture"] as const;
type ShapeSlot = (typeof SHAPE_SLOTS)[number];

const SHAPE_SLOT_GLYPH: Record<ShapeSlot, string> = {
  shapes: "⬡",
  photos: "🖼",
  capture: "▣",
};

export function nextShapeSlot(slot: ShapeSlot): ShapeSlot {
  return SHAPE_SLOTS[(SHAPE_SLOTS.indexOf(slot) + 1) % SHAPE_SLOTS.length]!;
}

export interface BoardToolbarProps {
  /**
   * Ink swatches for the colour wheel. Falls back to the authored palette when
   * absent.
   */
  inkPalette?: readonly string[];
  /** A swatch was held — put a different colour in that slot. */
  onEditInkColor?: (index: number, color: string) => void;
  /** Quick tap on the toolbar swatch — next palette. */
  onCycleInkPaletteNext?: () => void;
  /** Quick tap on the open hub — previous palette. */
  onCycleInkPalettePrev?: () => void;
  active: ToolName;
  onPick: (tool: ToolName) => void;
  /**
   * Ask-area: same two gestures as Scroll — native text drag, or hold then
   * marquee. Not an Excalidraw tool, which is why it is a flag rather than a
   * `ToolName`. Mutually exclusive with the pen.
   */
  highlighting?: boolean;
  onToggleHighlight?: () => void;
  themeId: string;
  inkColor: string;
  onInk: (color: string) => void;
  handedness: InkHandedness;
  strokeWidth: number;
  onStrokeWidth: (width: number) => void;
  inkFullness: number;
  onInkFullness: (fullness: number) => void;
  pressureSensitive: boolean;
  onPressureSensitive: (enabled: boolean) => void;
  fontSize: number;
  onFontSize: (size: number) => void;
  /** Plain text vs monospace code note (Text tool long-press). */
  textMode: "plain" | "code";
  onTextMode: (mode: "plain" | "code") => void;
  /** The data-structure library panel — opened from the shapes flyout. */
  shapesOpen: boolean;
  onToggleShapes: () => void;
  onStamp: (shape: ShapeStamp, mods: Record<string, ShapeModValue>, moveAsOne: boolean) => void;
  onPickImage: () => void;
  captureMenuOpen: boolean;
  onToggleCaptureMenu: () => void;
  onCaptureEntire: () => void;
  onCaptureRegion: () => void;
  /** Back to the original problem layout — the only destructive control here. */
  onReset: () => void;
  /** Pen / highlighter draw a straight chord from the starting point. */
  straightInk?: boolean;
  onStraightInk?: (on: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  mobile?: boolean;
  /** Reports island height so the page fit can clear it. */
  onHeightChange?: (height: number) => void;
  showColorWheel?: boolean;
  presetName?: string;
  presetColour?: string;
  wheelLocked?: boolean;
  onToggleWheelLock?: () => void;
  onOpenInkWheel?: () => void;
}

export function BoardToolbar({
  active,
  onPick,
  highlighting: _highlighting = false,
  onToggleHighlight: _onToggleHighlight,
  themeId,
  inkPalette,
  onEditInkColor,
  onCycleInkPaletteNext,
  onCycleInkPalettePrev,
  inkColor,
  onInk,
  handedness,
  strokeWidth,
  onStrokeWidth,
  inkFullness,
  onInkFullness,
  pressureSensitive,
  onPressureSensitive,
  fontSize,
  onFontSize,
  textMode: _textMode,
  onTextMode,
  shapesOpen,
  onToggleShapes,
  onStamp,
  onPickImage,
  captureMenuOpen,
  onToggleCaptureMenu,
  onCaptureEntire,
  onCaptureRegion,
  onReset,
  straightInk = false,
  onStraightInk,
  onUndo,
  onRedo,
  mobile = false,
  onHeightChange,
  showColorWheel: _showColorWheel = false,
  presetName = "Global",
  presetColour = "#3d3d3d",
  wheelLocked = true,
  onToggleWheelLock,
  onOpenInkWheel,
}: BoardToolbarProps) {
  // Ink nib / fullness / pressure live on presets. Text still has a size wheel.
  const showStrokeSizes = false;
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [shapeSlot, setShapeSlot] = useState<ShapeSlot>("shapes");
  const [shapeFlyout, setShapeFlyout] = useState<"shapes" | "capture">("shapes");
  const [resetLocked, setResetLocked] = useState(true);
  const [configuring, setConfiguring] = useState<ShapeStamp | null>(null);
  const [mods, setMods] = useState<Record<string, ShapeModValue>>({});
  const [moveAsOne, setMoveAsOne] = useState(true);
  const [shapePhase, setShapePhase] = useState<"list" | "fade" | "mod">("list");
  const toolbarRootRef = useRef<HTMLDivElement | null>(null);

  const [layout, setLayout] = useState<ToolbarLayout>(() => loadToolbarLayout());
  const [dragging, setDragging] = useState(false);
  const [docking, setDocking] = useState(false);
  const [dockNear, setDockNear] = useState(false);
  const dragHoldTimerRef = useRef<number | null>(null);
  const gripRef = useRef<HTMLButtonElement | null>(null);
  const [gripShake, setGripShake] = useState(false);
  const gripShakeRef = useRef(false);
  gripShakeRef.current = gripShake;
  const pendingGripRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    clientX: number;
    clientY: number;
    fromDocked: boolean;
    target: HTMLButtonElement;
  } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    clientX: number;
    clientY: number;
    gripOffsetX: number;
    gripOffsetY: number;
  } | null>(null);

  const floating = layout.mode === "floating";
  const floatX = layout.mode === "floating" ? layout.x : 0;
  const floatY = layout.mode === "floating" ? layout.y : 0;
  const axisPrevRef = useRef<"row" | "column">("row");
  const axis = toolbarAxis(
    layout.mode,
    floatX,
    toolbarRootRef.current?.offsetWidth ?? 400,
    typeof window === "undefined" ? 1280 : window.innerWidth,
    dockNear,
    axisPrevRef.current,
  );
  axisPrevRef.current = axis;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;

  const clearDragHold = useCallback(() => {
    if (dragHoldTimerRef.current != null) {
      window.clearTimeout(dragHoldTimerRef.current);
      dragHoldTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearDragHold, [clearDragHold]);

  // A press anywhere else closes any open flyout. Capture lives in Board's
  // state rather than ours, but it is the same kind of menu and has to dismiss
  // the same way — leaving it out is why it used to stay open behind a stroke.
  const captureMenuOpenRef = useRef(captureMenuOpen);
  captureMenuOpenRef.current = captureMenuOpen;
  const onToggleCaptureMenuRef = useRef(onToggleCaptureMenu);
  onToggleCaptureMenuRef.current = onToggleCaptureMenu;

  useEffect(() => {
    if (!shapeMenuOpen && !captureMenuOpen) return;
    const closeAll = () => {
      setShapeMenuOpen(false);
      if (captureMenuOpenRef.current) onToggleCaptureMenuRef.current();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && toolbarRootRef.current?.contains(target)) return;
      closeAll();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAll();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [captureMenuOpen, shapeMenuOpen]);

  // Read through a ref so an inline callback cannot rebuild the observer on
  // every render.
  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;

  useEffect(() => {
    const node = toolbarRootRef.current;
    if (!node) return;
    const publish = () => {
      // Floating chrome does not reserve dock clearance — page fit measures the
      // remaining bottom tray (pager / eye) instead.
      if (layout.mode === "floating") {
        onHeightChangeRef.current?.(0);
        return;
      }
      onHeightChangeRef.current?.(Math.ceil(node.getBoundingClientRect().height));
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => observer.disconnect();
  }, [layout.mode]);

  useEffect(() => {
    if (!shapesOpen) {
      setConfiguring(null);
      setMods({});
      setShapePhase("list");
    }
  }, [shapesOpen]);

  // Keep a restored floating position inside the board hole after rotate /
  // resize / coach open (App dispatches `resize` when the panel docks).
  useLayoutEffect(() => {
    if (layout.mode !== "floating" || dragging || docking) return;
    const clampNow = () => {
      const node = toolbarRootRef.current;
      const current = layoutRef.current;
      if (!node || current.mode !== "floating") return;
      const rect = node.getBoundingClientRect();
      const extraLeft = axis === "column" ? TOOLBAR_LEFT_CHROME_INSET_PX : 0;
      const next = clampFloatingPos(current.x, current.y, rect.width, rect.height, extraLeft);
      if (next.x !== current.x || next.y !== current.y) {
        const updated: ToolbarLayout = { mode: "floating", ...next };
        setLayout(updated);
        saveToolbarLayout(updated);
      }
    };
    clampNow();
    window.addEventListener("resize", clampNow);
    return () => window.removeEventListener("resize", clampNow);
  }, [layout.mode, dragging, docking, axis]);

  useLayoutEffect(() => {
    if (!dragging) return;
    const node = toolbarRootRef.current;
    const grip = gripRef.current;
    const drag = dragRef.current;
    if (!node || !grip || !drag) return;
    const rect = node.getBoundingClientRect();
    if (Math.abs(rect.width - drag.width) < 1 && Math.abs(rect.height - drag.height) < 1) {
      return;
    }
    const gripRect = grip.getBoundingClientRect();
    const dx = drag.clientX - drag.gripOffsetX - gripRect.left;
    const dy = drag.clientY - drag.gripOffsetY - gripRect.top;
    const extraLeft = axis === "column" ? TOOLBAR_LEFT_CHROME_INSET_PX : 0;
    const next = clampFloatingPos(
      rect.left + dx,
      rect.top + dy,
      rect.width,
      rect.height,
      extraLeft,
    );
    drag.width = rect.width;
    drag.height = rect.height;
    drag.offsetX = drag.clientX - next.x;
    drag.offsetY = drag.clientY - next.y;
    setLayout({ mode: "floating", ...next });
  }, [axis, dragging]);

  const finishDockAnimation = useCallback(() => {
    const docked: ToolbarLayout = { mode: "docked" };
    setLayout(docked);
    saveToolbarLayout(docked);
    setDocking(false);
    setDockNear(false);
    setDragging(false);
    dragRef.current = null;
  }, []);

  const onGripPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    if (docking) return;
    event.preventDefault();
    event.stopPropagation();
    clearDragHold();
    const fromDocked = layout.mode === "docked";
    const pointerId = event.pointerId;
    const clientX = event.clientX;
    const clientY = event.clientY;
    const target = event.currentTarget;
    pendingGripRef.current = {
      pointerId,
      startX: clientX,
      startY: clientY,
      clientX,
      clientY,
      fromDocked,
      target,
    };
    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* already captured */
    }
    dragHoldTimerRef.current = window.setTimeout(() => {
      dragHoldTimerRef.current = null;
      const pending = pendingGripRef.current;
      const node = toolbarRootRef.current;
      if (!pending || !node) return;
      setGripShake(false);
      const rect = node.getBoundingClientRect();
      const x = pending.fromDocked ? rect.left : floatX;
      const y = pending.fromDocked ? rect.top : floatY;
      setLayout({ mode: "floating", x, y });
      setDragging(true);
      setDocking(false);
      setShapeMenuOpen(false);
      const gripRect = pending.target.getBoundingClientRect();
      dragRef.current = {
        pointerId: pending.pointerId,
        offsetX: pending.clientX - x,
        offsetY: pending.clientY - y,
        width: rect.width,
        height: rect.height,
        clientX: pending.clientX,
        clientY: pending.clientY,
        gripOffsetX: pending.clientX - gripRect.left,
        gripOffsetY: pending.clientY - gripRect.top,
      };
    }, LONG_PRESS_MS);
  };

  const onGripPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const pending = pendingGripRef.current;
    if (pending && pending.pointerId === event.pointerId && !draggingRef.current) {
      pending.clientX = event.clientX;
      pending.clientY = event.clientY;
      const dist = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
      if (dist > 8 && !gripShakeRef.current && dragHoldTimerRef.current != null) {
        setGripShake(true);
      }
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !draggingRef.current) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    const tentative = { x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY };
    const nextAxis = toolbarAxis(
      "floating",
      tentative.x,
      drag.width,
      window.innerWidth,
      false,
      axisPrevRef.current,
    );
    const extraLeft = nextAxis === "column" ? TOOLBAR_LEFT_CHROME_INSET_PX : 0;
    const next = clampFloatingPos(tentative.x, tentative.y, drag.width, drag.height, extraLeft);
    setLayout({ mode: "floating", ...next });
    const anchor = dockAnchorRect(toolbarRootRef.current);
    if (anchor) {
      const cx = next.x + drag.width / 2;
      const cy = next.y + drag.height / 2;
      const ax = anchor.left + Math.max(anchor.width, 1) / 2;
      const ay = anchor.top + Math.max(12, anchor.height / 2);
      setDockNear(Math.hypot(cx - ax, cy - ay) < TOOLBAR_DOCK_SNAP_PX);
    } else {
      setDockNear(false);
    }
  };

  const onGripPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    clearDragHold();
    pendingGripRef.current = null;
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }
    if (!draggingRef.current) {
      dragRef.current = null;
      return;
    }

    const current = layoutRef.current;
    const curX = current.mode === "floating" ? current.x : floatX;
    const curY = current.mode === "floating" ? current.y : floatY;
    const anchor = dockAnchorRect(toolbarRootRef.current);
    const width = drag.width;
    const height = drag.height;
    const cx = curX + width / 2;
    const cy = curY + height / 2;
    let shouldDock = false;
    let dockX = curX;
    let dockY = curY;
    if (anchor) {
      const ax = anchor.left + Math.max(anchor.width, 1) / 2;
      const ay = anchor.top + Math.max(12, anchor.height / 2);
      shouldDock = Math.hypot(cx - ax, cy - ay) < TOOLBAR_DOCK_SNAP_PX;
      dockX = ax - width / 2;
      dockY = ay - height / 2;
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    if (shouldDock) {
      setDragging(false);
      setDocking(true);
      setDockNear(true);
      setLayout({ mode: "floating", x: dockX, y: dockY });
      window.setTimeout(finishDockAnimation, 320);
      return;
    }

    const saved: ToolbarLayout = {
      mode: "floating",
      ...clampFloatingPos(curX, curY, width, height),
    };
    setLayout(saved);
    saveToolbarLayout(saved);
    setDragging(false);
    setDockNear(false);
    dragRef.current = null;
  };

  const pickShape = (shape: ShapeStamp) => {
    setConfiguring(shape);
    setMods({ ...shape.defaults });
    setMoveAsOne(true);
    setShapePhase("fade");
    window.setTimeout(() => setShapePhase("mod"), 200);
  };

  const backToList = () => {
    setShapePhase("list");
    setConfiguring(null);
    setMods({});
  };

  const placeConfigured = () => {
    if (configuring) onStamp(configuring, mods, moveAsOne);
    backToList();
  };

  const modifierTitle = configuring?.label ?? "";

  const pickTool = (tool: ToolName) => {
    if (shapesOpen) onToggleShapes();
    if (captureMenuOpen) onToggleCaptureMenu();
    setShapeMenuOpen(false);
    if (tool === "text") onTextMode("plain");
    onPick(tool);
  };

  const shapeToolActive =
    shapesOpen ||
    active === "rectangle" ||
    active === "ellipse" ||
    active === "arrow" ||
    active === "text";
  const shapesUiActive =
    shapeMenuOpen || (shapeSlot === "shapes" && shapeToolActive);

  const openShapeFlyout = (panel: "shapes" | "capture") => {
    if (shapesOpen) onToggleShapes();
    setShapeFlyout(panel);
    setShapeMenuOpen(true);
  };

  const closeShapeMenus = () => {
    if (shapesOpen) onToggleShapes();
    setShapeMenuOpen(false);
  };

  const shapeHoldHint =
    shapeSlot === "shapes"
      ? "Shapes — tap for stamps · hold to switch to import photo"
      : shapeSlot === "photos"
        ? "Import photo — tap to pick · hold to switch to screencap"
        : "Screencap — tap for entire board or region · hold to switch to shapes";

  const renderToolButton = (tool: ToolName, label: string, hint: string) => (
    <button
      key={tool}
      type="button"
      className={
        tool === active && !shapesUiActive
          ? "lc-tool lc-tool-active lc-tip-target"
          : "lc-tool lc-tip-target"
      }
      aria-label={hint}
      data-tip={hint}
      data-tip-placement="bottom"
      aria-pressed={tool === active && !shapesUiActive}
      onClick={() => pickTool(tool)}
    >
      {tool === "selection" ? (
        <span className="lc-tool-emoji" aria-hidden>
          ⬚
        </span>
      ) : (
        <span className="lc-tool-emoji" aria-hidden>
          {label}
        </span>
      )}
    </button>
  );

  return (
    <div
      ref={toolbarRootRef}
      className={[
        "lc-toolbar",
        mobile ? "lc-toolbar-compact" : "",
        floating ? "lc-toolbar-floating" : "",
        dragging ? "lc-toolbar-dragging" : "",
        docking ? "lc-toolbar-docking" : "",
        gripShake ? "is-shake" : "",
        dockNear && (dragging || docking) ? "lc-toolbar-dock-near" : "",
        axis === "column" ? "is-column" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        floating || dragging || docking
          ? {
              position: "fixed",
              left: floatX,
              top: floatY,
              right: "auto",
              bottom: "auto",
              zIndex: 55,
            }
          : undefined
      }
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.animationName === "lc-stuck-shake") setGripShake(false);
      }}
      onPointerUp={() => {
        const root = toolbarRootRef.current;
        window.requestAnimationFrame(() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && root?.contains(active)) {
            active.blur();
          }
        });
      }}
      role="toolbar"
      aria-label="Drawing tools"
    >
      <div className="lc-toolbar-row">
        <button
          ref={gripRef}
          type="button"
          className="lc-toolbar-grip lc-tip-target"
          aria-label="Hold and drag to move toolbar"
          data-tip="Hold and drag to move · drop on the dock to pin"
          data-tip-placement="bottom"
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerUp}
          onPointerCancel={onGripPointerUp}
        >
          <span className="lc-toolbar-grip-dots" aria-hidden />
        </button>

        <div className="lc-color-wrap">
          <ColorRadial
            colors={inkPalette ?? inkSwatches(themeId)}
            onEditColor={onEditInkColor}
            onCycleNext={onCycleInkPaletteNext}
            onCyclePrev={onCycleInkPalettePrev}
            value={inkColor}
            onPick={onInk}
            handedness={handedness}
            compact={mobile}
          />
        </div>

        <HoldButton
          label={presetName}
          ariaLabel={
            wheelLocked
              ? `${presetName} locked — tap to unlock, hold to open presets`
              : `${presetName} unlocked — tap to lock, hold to open presets`
          }
          dataTip={
            wheelLocked
              ? `${presetName} locked — tap to unlock · hold for presets`
              : `${presetName} unlocked — tap to lock · hold for presets`
          }
          dataTipPlacement="bottom"
          className={[
            "lc-preset-chip lc-tip-target",
            wheelLocked ? "is-locked" : "",
          ].join(" ")}
          pressed={wheelLocked}
          holdMs={WHEEL_OPEN_MS}
          onTap={() => onToggleWheelLock?.()}
          onConfirm={() => onOpenInkWheel?.()}
          style={{
            background: presetColour,
            color: presetChipInk(presetColour),
          }}
        >
          <MorphBar
            active={presetName}
            axis={axis === "column" ? "height" : "width"}
            className="lc-preset-chip-morph"
          >
            <div data-morph-id={presetName}>
              <span className="lc-preset-chip-name">{presetName}</span>
            </div>
          </MorphBar>
        </HoldButton>

        {onStraightInk && (
          <button
            type="button"
            className={
              straightInk ? "lc-tool lc-tool-active lc-tip-target" : "lc-tool lc-tip-target"
            }
            aria-label="Straight stroke"
            aria-pressed={straightInk}
            data-tip={
              straightInk
                ? "Straight — line from where you put the nib down"
                : "Straight — pen and highlighter draw a line from the start"
            }
            data-tip-placement="bottom"
            onClick={() => onStraightInk(!straightInk)}
          >
            <StraightIcon />
          </button>
        )}

        <div className="lc-tool-sep" />

        {renderToolButton("selection", "Select", "Move or resize work")}

        <div className="lc-shapes-wrap">
          <HoldButton
            label={
              shapeSlot === "shapes"
                ? "Shapes"
                : shapeSlot === "photos"
                  ? "Import photo"
                  : "Screencap"
            }
            ariaLabel={shapeHoldHint}
            dataTip={shapeHoldHint}
            dataTipPlacement="bottom"
            className={[
              "lc-tool lc-tip-target lc-hold-icon",
              shapesUiActive ? "lc-tool-active" : "",
            ].join(" ")}
            pressed={shapesUiActive}
            holdMs={HOLD_MS}
            onTap={() => {
              if (shapeSlot === "photos") {
                closeShapeMenus();
                onPickImage();
                return;
              }
              if (shapeSlot === "capture") {
                if (shapesOpen) onToggleShapes();
                if (shapeMenuOpen && shapeFlyout === "capture") {
                  setShapeMenuOpen(false);
                  return;
                }
                openShapeFlyout("capture");
                return;
              }
              if (shapesOpen) onToggleShapes();
              if (shapeMenuOpen && shapeFlyout === "shapes") {
                setShapeMenuOpen(false);
                return;
              }
              openShapeFlyout("shapes");
            }}
            onConfirm={() => {
              const next = nextShapeSlot(shapeSlot);
              setShapeSlot(next);
              closeShapeMenus();
            }}
          >
            <span className="lc-tool-emoji" aria-hidden>
              {SHAPE_SLOT_GLYPH[shapeSlot]}
            </span>
          </HoldButton>
          {shapeMenuOpen && !shapesOpen && (
            <MorphBar
              active={shapeFlyout}
              className="lc-shape-flyout"
              axis="height"
              role="menu"
              aria-label={shapeFlyout === "capture" ? "Screencap" : "Shapes"}
            >
              <div data-morph-id="shapes">
                {SHAPE_TOOLS.map(({ tool, label, glyph }) => (
                  <button
                    key={`${tool}-${label}`}
                    type="button"
                    role="menuitem"
                    className={tool === active ? "is-active" : undefined}
                    onClick={() => pickTool(tool)}
                  >
                    <span className="lc-shape-flyout-glyph" aria-hidden>
                      {glyph}
                    </span>
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShapeMenuOpen(false);
                    onToggleShapes();
                  }}
                >
                  <span className="lc-shape-flyout-glyph" aria-hidden>
                    ⊞
                  </span>
                  Data structures…
                </button>
              </div>
              <div data-morph-id="capture">
                <button
                  type="button"
                  role="menuitem"
                  title="Shoot the whole board and drop the image on it"
                  onClick={() => {
                    setShapeMenuOpen(false);
                    onCaptureEntire();
                  }}
                >
                  <span className="lc-shape-flyout-glyph" aria-hidden>
                    ▣
                  </span>
                  Entire board
                </button>
                <button
                  type="button"
                  role="menuitem"
                  title="Drag a rectangle to shoot part of the board"
                  onClick={() => {
                    setShapeMenuOpen(false);
                    onCaptureRegion();
                  }}
                >
                  <span className="lc-shape-flyout-glyph" aria-hidden>
                    ⧉
                  </span>
                  Region…
                </button>
              </div>
            </MorphBar>
          )}
        </div>

        <div className="lc-tool-sep" />

        <button
          type="button"
          className="lc-tool lc-tip-target"
          aria-label="Undo"
          data-tip="Undo"
          data-tip-placement="bottom"
          onClick={onUndo}
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          className="lc-tool lc-tip-target"
          aria-label="Redo"
          data-tip="Redo"
          data-tip-placement="bottom"
          onClick={onRedo}
        >
          <RedoIcon />
        </button>
        <HoldButton
          label="Reset board"
          ariaLabel={
            resetLocked
              ? "Reset board locked — hold to unlock"
              : "Reset board unlocked — tap to reset, hold to lock"
          }
          dataTip={
            resetLocked
              ? "Reset locked — hold to unlock"
              : "Reset — tap to reset, hold to lock"
          }
          dataTipPlacement="bottom"
          className={[
            "lc-tool lc-tip-target lc-hold-icon",
            resetLocked ? "is-locked" : "lc-hold-danger",
          ].join(" ")}
          pressed={!resetLocked}
          onConfirm={() => setResetLocked((locked) => !locked)}
          onTap={() => {
            if (resetLocked) return;
            onReset();
            setResetLocked(true);
          }}
        >
          <ResetIcon />
        </HoldButton>

        {showStrokeSizes && (
          <div className="lc-stroke-controls">
            <StrokeSizeSlider
              value={strokeWidth}
              onChange={onStrokeWidth}
              label={active === "eraser" ? "Eraser size" : "Stroke weight"}
              eraser={active === "eraser"}
            />
            {active === "freedraw" && (
              <>
                <div
                  className={
                    pressureSensitive ? "lc-ink-fold is-open" : "lc-ink-fold"
                  }
                  inert={!pressureSensitive || undefined}
                >
                  <div className="lc-ink-fold-inner">
                    <InkFullnessSlider
                      value={inkFullness}
                      onChange={onInkFullness}
                      enabled={pressureSensitive}
                    />
                  </div>
                </div>
                <PressureSensitiveToggle
                  enabled={pressureSensitive}
                  onChange={onPressureSensitive}
                />
              </>
            )}
          </div>
        )}

        {active === "text" && (
          <div className="lc-stroke-controls">
            <FontSizeSlider value={fontSize} onChange={onFontSize} />
          </div>
        )}
      </div>

      {shapesOpen && (
        <div
          className={shapePhase === "mod" ? "lc-shapes lc-shapes-modifying" : "lc-shapes"}
          role="menu"
          aria-label="Shape library"
        >
          {shapePhase !== "mod" && (
            <>
              {SHAPE_GROUPS.map((group) => {
                const items = SHAPES.filter((shape) => shape.group === group);
                if (
                  shapePhase === "fade" &&
                  configuring &&
                  !items.some((shape) => shape.id === configuring.id)
                ) {
                  return (
                    <div key={group} className="lc-shape-group lc-shape-group-fade" aria-hidden>
                      <h4>{group}</h4>
                    </div>
                  );
                }
                return (
                  <div key={group} className="lc-shape-group">
                    <h4 className={shapePhase === "fade" ? "lc-shape-heading-fade" : undefined}>
                      {group}
                    </h4>
                    {items.map((shape) => {
                      const fading =
                        shapePhase === "fade" && configuring && configuring.id !== shape.id;
                      const rising =
                        shapePhase === "fade" && configuring && configuring.id === shape.id;
                      return (
                        <button
                          key={shape.id}
                          type="button"
                          role="menuitem"
                          className={
                            rising
                              ? "lc-shape lc-shape-rising"
                              : fading
                                ? "lc-shape lc-shape-fade"
                                : "lc-shape"
                          }
                          onClick={() => pickShape(shape)}
                        >
                          {shape.label}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}

          {shapePhase === "mod" && configuring && (
            <div className="lc-shape-modifier">
              <button type="button" className="lc-shape-back" onClick={backToList}>
                ← {modifierTitle}
              </button>
              <p className="lc-muted lc-shape-mod-hint">Configure, then place on the board.</p>
              {configuring?.fields.map((field) => (
                <label key={field.key} className="lc-shape-field">
                  <span>{field.label}</span>
                  {field.kind === "int" ? (
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={field.step ?? 1}
                      value={Number(mods[field.key] ?? configuring.defaults[field.key] ?? 0)}
                      onChange={(event) =>
                        setMods((current) => ({
                          ...current,
                          [field.key]: Number(event.target.value),
                        }))
                      }
                    />
                  ) : (
                    <input
                      type="text"
                      placeholder={field.placeholder}
                      value={String(mods[field.key] ?? configuring.defaults[field.key] ?? "")}
                      onChange={(event) =>
                        setMods((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") placeConfigured();
                      }}
                    />
                  )}
                </label>
              ))}
              <label className="lc-shape-lock">
                <input
                  type="checkbox"
                  checked={moveAsOne}
                  onChange={(event) => setMoveAsOne(event.target.checked)}
                />
                <span>
                  <strong>Move as one piece</strong>
                  <span className="lc-muted">
                    {" "}
                    — on: drag the whole graphic together; off: move parts separately
                  </span>
                </span>
              </label>
              <button type="button" className="lc-shape-place" onClick={placeConfigured}>
                Place on board
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResetIcon() {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 12a9 9 0 0 1 15.5-6.4L21 8"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 3v5h-5"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 12a9 9 0 0 1-15.5 6.4L3 16"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 21v-5h5"
      />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 14 4 9l5-5"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 9h10.5a5.5 5.5 0 0 1 0 11H13"
      />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m15 14 5-5-5-5"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20 9H9.5a5.5 5.5 0 0 0 0 11H11"
      />
    </svg>
  );
}
