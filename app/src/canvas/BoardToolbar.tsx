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
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  SHAPES,
  SHAPE_GROUPS,
  type ShapeModValue,
  type ShapeStamp,
} from "../templates/shapes";
import type { InkHandedness } from "../util/inkHandedness";
import type { ToolName } from "./BoardHandle";
import { ColorRadial } from "./ColorRadial";
import { FontSizeSlider } from "./FontSizeSlider";
import { inkSwatches } from "./inkColors";
import { PressureSensitiveToggle } from "./PressureSensitiveToggle";
import { StrokeSizeSlider } from "./StrokeSizeSlider";

/** Hold this long on Text to open Text / Code (click also toggles the menu). */
const TEXT_HOLD_MS = 240;

/** The five tools that earn a permanent seat on the bar. */
const TOOLS: Array<{ tool: ToolName; label: string; hint: string; icon?: "pen" | "eraser" }> = [
  { tool: "hand", label: "✋", hint: "Pan — drag to move; scroll wheel zooms" },
  {
    tool: "selection",
    label: "⬚",
    hint: "Select — resize region boxes (they stay locked in place) or move your work",
  },
  { tool: "freedraw", label: "Pen", hint: "Pen", icon: "pen" },
  { tool: "eraser", label: "Eraser", hint: "Eraser — only removes ink under the brush", icon: "eraser" },
  {
    tool: "text",
    label: "T",
    hint: "Text — click to place (Enter finishes, Shift+Enter for a new line)",
  },
];

/** Shapes that used to hold their own seats; now they live behind the flyout. */
const SHAPE_TOOLS: Array<{ tool: ToolName; label: string; glyph: string }> = [
  { tool: "rectangle", label: "Square", glyph: "▭" },
  { tool: "ellipse", label: "Circle", glyph: "◯" },
  { tool: "arrow", label: "Arrow", glyph: "↗" },
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
  pressureSensitive,
  onPressureSensitive,
  fontSize,
  onFontSize,
  textMode,
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
  const [textFlyoutOpen, setTextFlyoutOpen] = useState(false);
  const textHoldTimerRef = useRef<number | null>(null);
  const toolbarRootRef = useRef<HTMLDivElement | null>(null);

  const clearTextHold = useCallback(() => {
    if (textHoldTimerRef.current != null) {
      window.clearTimeout(textHoldTimerRef.current);
      textHoldTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearTextHold, [clearTextHold]);

  // A press anywhere else closes the text / shape flyouts.
  useEffect(() => {
    if (!textFlyoutOpen && !shapeMenuOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && toolbarRootRef.current?.contains(target)) return;
      setTextFlyoutOpen(false);
      setShapeMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTextFlyoutOpen(false);
        setShapeMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [textFlyoutOpen, shapeMenuOpen]);

  // Read through a ref so an inline callback cannot rebuild the observer on
  // every render.
  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;

  useEffect(() => {
    const node = toolbarRootRef.current;
    if (!node) return;
    const publish = () =>
      onHeightChangeRef.current?.(Math.ceil(node.getBoundingClientRect().height));
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shapesOpen) {
      setConfiguring(null);
      setMods({});
      setShapePhase("list");
    }
  }, [shapesOpen]);

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
    setTextFlyoutOpen(false);
    onPick(tool);
  };

  const pickTextVariant = (mode: "plain" | "code") => {
    clearTextHold();
    setTextFlyoutOpen(false);
    if (shapesOpen) onToggleShapes();
    if (captureMenuOpen) onToggleCaptureMenu();
    setShapeMenuOpen(false);
    onTextMode(mode);
  };

  const onTextToolClick = () => {
    clearTextHold();
    if (active === "text" && !shapesOpen) {
      setTextFlyoutOpen((open) => !open);
      return;
    }
    pickTextVariant(textMode);
    setTextFlyoutOpen(true);
  };

  const shapeToolActive = SHAPE_TOOLS.some((entry) => entry.tool === active);

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
      ]
        .filter(Boolean)
        .join(" ")}
      role="toolbar"
      aria-label="Drawing tools"
    >
      <div className="lc-toolbar-row">
        {TOOLS.map(({ tool, label, hint, icon }) =>
          tool === "text" ? (
            <div key="text" className="lc-text-wrap">
              <button
                type="button"
                className={
                  active === "text" && !shapesOpen
                    ? "lc-tool lc-tool-active"
                    : "lc-tool"
                }
                aria-label={
                  textMode === "code"
                    ? "Code note — click for Text / Code"
                    : "Text — click for Text / Code"
                }
                title={
                  textMode === "code"
                    ? "Code note (monospace on canvas) — click for Text / Code"
                    : "Text — click for Text / Code"
                }
                aria-pressed={active === "text" && !shapesOpen}
                aria-haspopup="menu"
                aria-expanded={textFlyoutOpen}
                onClick={onTextToolClick}
                onPointerDown={() => {
                  clearTextHold();
                  textHoldTimerRef.current = window.setTimeout(() => {
                    textHoldTimerRef.current = null;
                    setShapeMenuOpen(false);
                    setTextFlyoutOpen(true);
                  }, TEXT_HOLD_MS);
                }}
                onPointerUp={clearTextHold}
                onPointerCancel={clearTextHold}
              >
                <span className="lc-tool-emoji" aria-hidden>
                  {textMode === "code" ? "</>" : "T"}
                </span>
              </button>
              {textFlyoutOpen && (
                <div className="lc-text-flyout" role="menu" aria-label="Text mode">
                  <button
                    type="button"
                    role="menuitem"
                    className={textMode === "plain" ? "is-active" : undefined}
                    onClick={() => pickTextVariant("plain")}
                  >
                    <span className="lc-text-flyout-glyph" aria-hidden>
                      T
                    </span>
                    Text
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={textMode === "code" ? "is-active" : undefined}
                    onClick={() => pickTextVariant("code")}
                  >
                    <span className="lc-text-flyout-glyph" aria-hidden>
                      {"</>"}
                    </span>
                    Code note
                    <span className="lc-muted lc-text-flyout-sub">Monospace on canvas</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            renderToolButton(tool, label, hint, icon)
          ),
        )}

        <div className="lc-tool-sep" />

        <div className="lc-shapes-wrap">
          <button
            type="button"
            className={
              shapeMenuOpen || shapesOpen || shapeToolActive ? "lc-tool lc-tool-active" : "lc-tool"
            }
            aria-label="Shapes"
            title="Shapes"
            aria-expanded={shapeMenuOpen}
            aria-haspopup="menu"
            onClick={() => {
              if (shapesOpen) onToggleShapes();
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
              <PressureSensitiveToggle
                enabled={pressureSensitive}
                onChange={onPressureSensitive}
              />
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
