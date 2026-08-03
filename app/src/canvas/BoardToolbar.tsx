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
 * Everything that is not a tool hides behind a press: shapes fan out of one
 * button, colour fans out of one dot ({@link ColorRadial}).
 *
 * Long-press the grip to undock and drag the island anywhere on the workspace;
 * drop near the bottom dock slot to snap it home with a short settle animation.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  SHAPES,
  SHAPE_GROUPS,
  type ShapeModValue,
  type ShapeStamp,
} from "../templates/shapes";
import { LONG_PRESS_MS } from "../util/gesture";
import type { InkHandedness } from "../util/inkHandedness";
import {
  loadToolbarLayout,
  saveToolbarLayout,
  TOOLBAR_DOCK_SNAP_PX,
  type ToolbarLayout,
} from "../util/toolbarLayout";
import type { ToolName } from "./BoardHandle";
import { ColorRadial } from "./ColorRadial";
import { FontSizeSlider } from "./FontSizeSlider";
import { inkSwatches } from "./inkColors";
import { InkFullnessSlider } from "./InkFullnessSlider";
import { PressureSensitiveToggle } from "./PressureSensitiveToggle";
import { StrokeSizeSlider } from "./StrokeSizeSlider";

function clampFloatingPos(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  const maxY = Math.max(margin, window.innerHeight - height - margin);
  return {
    x: Math.min(maxX, Math.max(margin, x)),
    y: Math.min(maxY, Math.max(margin, y)),
  };
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

/** Permanent seats (Hand + Select share one seat via the Hand flyout). */
const TOOLS: Array<{ tool: ToolName; label: string; hint: string; icon?: "pen" | "eraser" }> = [
  { tool: "freedraw", label: "Pen", hint: "Pen", icon: "pen" },
  { tool: "eraser", label: "Eraser", hint: "Eraser — only removes ink under the brush", icon: "eraser" },
];

/** Shapes flyout — same menu the ⬡ button opens (includes Text box). */
const SHAPE_TOOLS: Array<{ tool: ToolName; label: string; glyph: string }> = [
  { tool: "rectangle", label: "Square", glyph: "▭" },
  { tool: "ellipse", label: "Circle", glyph: "◯" },
  { tool: "arrow", label: "Arrow", glyph: "↗" },
  { tool: "text", label: "Text box", glyph: "T" },
];

const HAND_TOOLS: Array<{ tool: "hand" | "selection"; label: string; glyph: string; hint: string }> = [
  { tool: "hand", label: "Hand", glyph: "✋", hint: "Pan the board" },
  { tool: "selection", label: "Select", glyph: "⬚", hint: "Move or resize work" },
];

export interface BoardToolbarProps {
  active: ToolName;
  onPick: (tool: ToolName) => void;
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
  onUndo: () => void;
  onRedo: () => void;
  mobile?: boolean;
  /** Reports island height so the page fit can clear it. */
  onHeightChange?: (height: number) => void;
}

export function BoardToolbar({
  active,
  onPick,
  themeId,
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
  onUndo,
  onRedo,
  mobile = false,
  onHeightChange,
}: BoardToolbarProps) {
  // Stroke weight is for pen / shapes / eraser — text has its own wheel.
  const showStrokeSizes =
    active === "freedraw" ||
    active === "rectangle" ||
    active === "ellipse" ||
    active === "arrow" ||
    active === "eraser";
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [configuring, setConfiguring] = useState<ShapeStamp | null>(null);
  const [mods, setMods] = useState<Record<string, ShapeModValue>>({});
  const [moveAsOne, setMoveAsOne] = useState(true);
  const [shapePhase, setShapePhase] = useState<"list" | "fade" | "mod">("list");
  const [helpOpen, setHelpOpen] = useState(false);
  const [handMenuOpen, setHandMenuOpen] = useState(false);
  const toolbarRootRef = useRef<HTMLDivElement | null>(null);

  const [layout, setLayout] = useState<ToolbarLayout>(() => loadToolbarLayout());
  const [dragging, setDragging] = useState(false);
  const [docking, setDocking] = useState(false);
  const [dockNear, setDockNear] = useState(false);
  const dragHoldTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);

  const floating = layout.mode === "floating";
  const floatX = layout.mode === "floating" ? layout.x : 0;
  const floatY = layout.mode === "floating" ? layout.y : 0;
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

  // A press anywhere else closes the hand / shape flyouts.
  useEffect(() => {
    if (!handMenuOpen && !shapeMenuOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && toolbarRootRef.current?.contains(target)) return;
      setHandMenuOpen(false);
      setShapeMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHandMenuOpen(false);
        setShapeMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [handMenuOpen, shapeMenuOpen]);

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

  // Keep a restored floating position on-screen after rotate / resize.
  useLayoutEffect(() => {
    if (layout.mode !== "floating" || dragging || docking) return;
    const node = toolbarRootRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const next = clampFloatingPos(layout.x, layout.y, rect.width, rect.height);
    if (next.x !== layout.x || next.y !== layout.y) {
      const updated: ToolbarLayout = { mode: "floating", ...next };
      setLayout(updated);
      saveToolbarLayout(updated);
    }
  }, [layout, dragging, docking]);

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
    dragHoldTimerRef.current = window.setTimeout(() => {
      dragHoldTimerRef.current = null;
      const node = toolbarRootRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const x = fromDocked ? rect.left : floatX;
      const y = fromDocked ? rect.top : floatY;
      setLayout({ mode: "floating", x, y });
      setDragging(true);
      setDocking(false);
      setShapeMenuOpen(false);
      setHandMenuOpen(false);
      setHelpOpen(false);
      dragRef.current = {
        pointerId,
        offsetX: clientX - x,
        offsetY: clientY - y,
        width: rect.width,
        height: rect.height,
      };
      try {
        target.setPointerCapture(pointerId);
      } catch {
        /* already captured */
      }
    }, LONG_PRESS_MS);
  };

  const onGripPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !draggingRef.current) return;
    const next = clampFloatingPos(
      event.clientX - drag.offsetX,
      event.clientY - drag.offsetY,
      drag.width,
      drag.height,
    );
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
    setHandMenuOpen(false);
    if (tool === "text") onTextMode("plain");
    onPick(tool);
  };

  const shapeToolActive =
    shapesOpen ||
    active === "rectangle" ||
    active === "ellipse" ||
    active === "arrow" ||
    active === "text";

  const handToolActive = active === "hand" || active === "selection";
  const handGlyph = active === "selection" ? "⬚" : "✋";

  const renderToolButton = (
    tool: ToolName,
    label: string,
    hint: string,
    icon?: "pen" | "eraser",
  ) => (
    <button
      key={tool}
      type="button"
      className={tool === active && !shapesOpen ? "lc-tool lc-tool-active" : "lc-tool"}
      aria-label={hint}
      title={hint}
      aria-pressed={tool === active && !shapesOpen}
      onClick={() => pickTool(tool)}
    >
      {icon === "eraser" ? (
        <PinkEraserIcon />
      ) : icon === "pen" ? (
        <PenIcon />
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
        dockNear && (dragging || docking) ? "lc-toolbar-dock-near" : "",
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
      role="toolbar"
      aria-label="Drawing tools"
    >
      <div className="lc-toolbar-row">
        <button
          type="button"
          className="lc-toolbar-grip"
          aria-label="Hold and drag to move toolbar"
          title="Hold and drag to move · drop on the dock to pin"
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerUp}
          onPointerCancel={onGripPointerUp}
        >
          <span className="lc-toolbar-grip-dots" aria-hidden />
        </button>
        <div className="lc-hand-wrap">
          <button
            type="button"
            className={
              handToolActive && !shapesOpen ? "lc-tool lc-tool-active" : "lc-tool"
            }
            aria-label={
              active === "selection"
                ? "Select — tap for Hand / Select"
                : "Pan — tap for Hand / Select"
            }
            title={
              active === "selection"
                ? "Select — tap for Hand / Select"
                : "Pan — tap for Hand / Select"
            }
            aria-pressed={handToolActive && !shapesOpen}
            aria-haspopup="menu"
            aria-expanded={handMenuOpen}
            onClick={() => {
              setShapeMenuOpen(false);
              setHandMenuOpen((open) => !open);
            }}
          >
            <span className="lc-tool-emoji" aria-hidden>
              {handGlyph}
            </span>
          </button>
          {handMenuOpen && (
            <div className="lc-shape-flyout" role="menu" aria-label="Hand tools">
              {HAND_TOOLS.map(({ tool, label, glyph, hint }) => (
                <button
                  key={tool}
                  type="button"
                  role="menuitem"
                  className={tool === active ? "is-active" : undefined}
                  onClick={() => pickTool(tool)}
                >
                  <span className="lc-shape-flyout-glyph" aria-hidden>
                    {glyph}
                  </span>
                  {label}
                  <span className="lc-muted lc-text-flyout-sub">{hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {TOOLS.map(({ tool, label, hint, icon }) =>
          renderToolButton(tool, label, hint, icon),
        )}

        <div className="lc-tool-sep" />

        <div className="lc-shapes-wrap">
          <button
            type="button"
            className={
              shapeMenuOpen || shapesOpen || shapeToolActive ? "lc-tool lc-tool-active" : "lc-tool"
            }
            aria-label="Shapes"
            title="Shapes — Square, Circle, Arrow, Text box"
            aria-expanded={shapeMenuOpen}
            aria-haspopup="menu"
            onClick={() => {
              if (shapesOpen) onToggleShapes();
              setHandMenuOpen(false);
              setShapeMenuOpen((open) => !open);
            }}
          >
            <span className="lc-tool-emoji" aria-hidden>
              ⬡
            </span>
          </button>
          {shapeMenuOpen && !shapesOpen && (
            <div className="lc-shape-flyout" role="menu" aria-label="Shapes">
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
          )}
        </div>

        <button
          type="button"
          className="lc-tool"
          aria-label="Add image"
          title="Add image"
          onClick={onPickImage}
        >
          <span className="lc-tool-emoji" aria-hidden>
            🖼
          </span>
        </button>

        <div className="lc-capture-wrap">
          <button
            type="button"
            className={captureMenuOpen ? "lc-tool lc-tool-active" : "lc-tool"}
            aria-label="Capture board"
            aria-expanded={captureMenuOpen}
            title="Capture board"
            onClick={() => {
              setShapeMenuOpen(false);
              onToggleCaptureMenu();
            }}
          >
            <span className="lc-tool-emoji" aria-hidden>
              📷
            </span>
          </button>
          {captureMenuOpen && (
            <div className="lc-capture-menu" role="menu">
              <button type="button" role="menuitem" onClick={onCaptureEntire}>
                Entire board
              </button>
              <button type="button" role="menuitem" onClick={onCaptureRegion}>
                Region…
              </button>
            </div>
          )}
        </div>

        <div className="lc-tool-sep" />

        <button type="button" className="lc-tool" aria-label="Undo" title="Undo" onClick={onUndo}>
          <UndoIcon />
        </button>
        <button type="button" className="lc-tool" aria-label="Redo" title="Redo" onClick={onRedo}>
          <RedoIcon />
        </button>
        <button
          type="button"
          className="lc-tool"
          aria-label="Reset board"
          title="Reset board"
          onClick={onReset}
        >
          <ResetIcon />
        </button>

        <div className="lc-tool-sep" />

        <div className="lc-color-wrap">
          <ColorRadial
            colors={inkSwatches(themeId)}
            value={inkColor}
            onPick={onInk}
            handedness={handedness}
            compact={mobile}
          />
        </div>

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
                <InkFullnessSlider value={inkFullness} onChange={onInkFullness} />
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

        {!mobile && (
          <button
            type="button"
            className={helpOpen ? "lc-tool lc-tool-active" : "lc-tool"}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((open) => !open)}
          >
            ?
          </button>
        )}
      </div>

      {!mobile && helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}

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

/**
 * What the keyboard actually does on this board.
 *
 * Excalidraw's own single-key shortcuts are suppressed by the key guard in
 * `Board`, because they belong to a UI this app hides: pressing `s` or `g` on a
 * selected shape used to open a colour palette nobody asked for, and `1`–`9`
 * silently swapped tools out from under the pen. What is left is this list, and
 * this button is where you can read it.
 */
function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="lc-shortcuts" role="dialog" aria-label="Keyboard shortcuts">
      <header className="lc-shortcuts-head">
        <strong>Keyboard</strong>
        <button type="button" className="lc-link" onClick={onClose}>
          close
        </button>
      </header>
      <dl className="lc-shortcuts-list">
        {BOARD_SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="lc-shortcut">
            <dt>{keys}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const BOARD_SHORTCUTS: Array<[string, string]> = [
  ["Ctrl / ⌘ + Z", "Undo"],
  ["Ctrl / ⌘ + Shift + Z", "Redo"],
  ["Scroll", "Zoom toward the pointer"],
  ["Shift + scroll", "Pan sideways"],
  ["Space + drag", "Pan"],
  ["Delete / Backspace", "Delete the selection"],
  ["Escape", "Deselect / close a popover"],
  ["Enter", "Finish a text box (Shift + Enter for a new line)"],
  ["Arrow keys", "Nudge the selection"],
];

function PinkEraserIcon() {
  return (
    <svg className="lc-tool-svg lc-tool-eraser" viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <g transform="rotate(-28 12 12)">
        <rect x="4.5" y="7" width="15" height="11" rx="2.2" fill="#f9a8d4" stroke="#be185d" strokeWidth="1.2" />
        <rect x="4.5" y="7" width="15" height="3.8" rx="1.2" fill="#fb7185" />
        <rect x="4.5" y="15.2" width="15" height="2.8" fill="#fff1f2" opacity="0.95" />
      </g>
    </svg>
  );
}

function PenIcon() {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.5 4.5 19.5 9.5 9 20H4v-5Z"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        d="m12.5 6.5 5 5"
      />
    </svg>
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
