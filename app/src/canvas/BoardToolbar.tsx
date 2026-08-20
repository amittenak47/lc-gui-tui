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
  isNearDock,
  loadToolbarLayout,
  saveToolbarLayout,
  TOOLBAR_LEFT_CHROME_INSET_PX,
  toolbarAxis,
  toolbarWindowIsNarrow,
  type ToolbarLayout,
} from "../util/toolbarLayout";
import type { MdFormatKind } from "../modes/AnnotateMarkdownEditor";
import type { ToolName } from "./BoardHandle";
import { ColorRadial } from "./ColorRadial";
import {
  cycleResetClearMode,
  resetClearModeLabel,
  type ResetClearMode,
} from "./resetClearMode";
import { FontSizeSlider } from "./FontSizeSlider";
import { inkSwatches } from "./inkColors";
import { InkFullnessSlider } from "./InkFullnessSlider";
import { PressureSensitiveToggle } from "./PressureSensitiveToggle";
import { StrokeSizeSlider } from "./StrokeSizeSlider";

/*
 * How many live toolbars want the narrow rail.
 *
 * A split with an explore pane paints chrome from both halves, so one of them
 * unmounting must not clear a flag the other still needs.
 */
let narrowVotes = 0;

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
  /** Back to a clean board — mode is ink, annotations, or both. */
  onReset: (mode: ResetClearMode) => void;
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
  /**
   * Markdown mode: the same island, a different set of tools in it.
   *
   * Not a second toolbar. Everything that makes this thing usable — the grip,
   * the drag, the dock snap, turning into a column when the window runs out of
   * room, shrinking with the rail — is behaviour of the island, not of the pen.
   * Writing a note wants all of it and none of the pen's buttons, so the row's
   * contents swap and the island stays.
   */
  markdown?: boolean;
  onMdFormat?: (kind: MdFormatKind) => void;
}

/**
 * What the island holds while a note is being written.
 *
 * Every one of these inserts markdown at the caret rather than styling a
 * selection, because the document *is* the markdown — there is no rich-text
 * layer to be out of step with, and a reader who knows the syntax can always
 * type it instead.
 */
const MD_TOOLS: Array<{ kind: MdFormatKind; glyph: string; label: string; tip: string }> = [
  { kind: "heading", glyph: "H", label: "Heading", tip: "Heading — # at the line start" },
  { kind: "bold", glyph: "B", label: "Bold", tip: "Bold — **around the words**" },
  { kind: "italic", glyph: "I", label: "Italic", tip: "Italic — *around the words*" },
  { kind: "list", glyph: "•", label: "List", tip: "List — a dash at the line start" },
  { kind: "quote", glyph: "❝", label: "Quote", tip: "Quote — > at the line start" },
  { kind: "task", glyph: "☑", label: "Task", tip: "Task — a checkbox you can tick" },
  { kind: "link", glyph: "🔗", label: "Link", tip: "Link — [text](url)" },
  { kind: "fence", glyph: "</>", label: "Code block", tip: "Code block — a fenced ``` block" },
];

function MarkdownTools({ onFormat }: { onFormat?: (kind: MdFormatKind) => void }) {
  return (
    <>
      {MD_TOOLS.map((tool) => (
        <button
          key={tool.kind}
          type="button"
          className="lc-tool lc-tip-target"
          aria-label={tool.label}
          data-tip={tool.tip}
          data-tip-placement="bottom"
          onClick={() => onFormat?.(tool.kind)}
        >
          <span className="lc-tool-emoji" aria-hidden>
            {tool.glyph}
          </span>
        </button>
      ))}
    </>
  );
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
  markdown = false,
  onMdFormat,
}: BoardToolbarProps) {
  // Ink nib / fullness / pressure live on presets. Text still has a size wheel.
  const showStrokeSizes = false;
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [shapeSlot, setShapeSlot] = useState<ShapeSlot>("shapes");
  const [shapeFlyout, setShapeFlyout] = useState<"shapes" | "capture">("shapes");
  const [resetLocked, setResetLocked] = useState(true);
  const [resetMode, setResetMode] = useState<ResetClearMode>("all");
  const [configuring, setConfiguring] = useState<ShapeStamp | null>(null);
  const [mods, setMods] = useState<Record<string, ShapeModValue>>({});
  const [moveAsOne, setMoveAsOne] = useState(true);
  const [shapePhase, setShapePhase] = useState<"list" | "fade" | "mod">("list");
  const toolbarRootRef = useRef<HTMLDivElement | null>(null);

  const [layout, setLayout] = useState<ToolbarLayout>(() => loadToolbarLayout());
  const rowRef = useRef<HTMLDivElement | null>(null);
  /*
   * The app window, and the length this row actually wants in it.
   *
   * Both are what decides row vs column now. The board under the island used
   * to decide, and it was the wrong box twice over — see `toolbarWindowIsNarrow`.
   */
  const [viewWidth, setViewWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [rowWidth, setRowWidth] = useState(0);
  /*
   * A toolbar already on screen when this one mounts is a *handover*, not an
   * opening: the other half of a split had the pen out and focus moved. React
   * has not committed the swap yet at this point, so the outgoing island is
   * still in the DOM and this is the one moment it can be asked.
   */
  const [handover] = useState(
    () =>
      typeof document !== "undefined" &&
      document.querySelector(".lc-toolbar") != null,
  );
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
  /*
   * The window has run out of room for a row. Read before `toolbarAxis` so
   * both see the same `previous`; the axis asks the same question internally,
   * but the *chrome scale* is a window fact, not an island fact — a floating
   * island parked on an edge of a wide screen is a column and must not shrink
   * the whole board's controls.
   */
  const windowNarrow = toolbarWindowIsNarrow(viewWidth, rowWidth, axisPrevRef.current);
  const axis = toolbarAxis(
    layout.mode,
    floatX,
    toolbarRootRef.current?.offsetWidth ?? 400,
    viewWidth,
    dockNear,
    axisPrevRef.current,
    rowWidth,
  );
  axisPrevRef.current = axis;
  /*
   * Which way a flyout opens off a column.
   *
   * A column grows up the side of the window, so the panel's usual "above the
   * button" landed on the island itself. Docked it is stacked against the map
   * chrome on the right, so it opens left; floating it opens away from whichever
   * edge it is parked on.
   */
  const flyoutSide: "up" | "left" | "right" =
    axis !== "column"
      ? "up"
      : layout.mode === "docked"
        ? // Docked, the column is in the rail, and the rail changes sides with
          // the writing hand.
          handedness === "left"
          ? "right"
          : "left"
        : floatX + (toolbarRootRef.current?.offsetWidth ?? 56) / 2 > viewWidth / 2
          ? "left"
          : "right";
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

  /*
   * One flag on the root for every rule that has to shrink with the window.
   *
   * The board's map chrome is rendered by Board, which knows nothing about the
   * island's axis, and both have to agree — the pen column stacks into the same
   * right-hand rail as the view stack and the two are sized together.
   */
  useEffect(() => {
    if (!windowNarrow) return;
    narrowVotes += 1;
    document.documentElement.dataset.lcChromeNarrow = "1";
    return () => {
      narrowVotes = Math.max(0, narrowVotes - 1);
      if (narrowVotes === 0) delete document.documentElement.dataset.lcChromeNarrow;
    };
  }, [windowNarrow]);

  /*
   * Crossing into the narrow rail puts a parked island back on the dock.
   *
   * Resizing inside one layout leaves a floating island exactly where it was
   * put — that is the whole point of parking it. Crossing the threshold is a
   * different event: the island changes shape, and a position chosen for a row
   * on a wide board is not a position anyone meant for a column on a small one.
   * It ends up somewhere arbitrary, and arbitrary is the one thing a remembered
   * position must not be.
   *
   * The parked spot is *not* overwritten in storage — it is handed back on the
   * way out, unless the island was moved again in the meantime, in which case
   * the newer choice is the real one.
   */
  const wasNarrowRef = useRef(false);
  const parkedRef = useRef<ToolbarLayout | null>(null);
  useEffect(() => {
    const was = wasNarrowRef.current;
    wasNarrowRef.current = windowNarrow;
    if (windowNarrow === was) return;
    if (windowNarrow) {
      if (layoutRef.current.mode !== "floating") return;
      parkedRef.current = layoutRef.current;
      setLayout({ mode: "docked" });
      return;
    }
    const parked = parkedRef.current;
    parkedRef.current = null;
    // Moved by hand while narrow — that is the position now, not the old one.
    if (!parked || layoutRef.current.mode !== "docked") return;
    setLayout(parked);
  }, [windowNarrow]);

  /** The app window is the box the axis is decided against. */
  useEffect(() => {
    const publish = () =>
      setViewWidth((was) => (was === window.innerWidth ? was : window.innerWidth));
    publish();
    window.addEventListener("resize", publish);
    window.visualViewport?.addEventListener("resize", publish);
    return () => {
      window.removeEventListener("resize", publish);
      window.visualViewport?.removeEventListener("resize", publish);
    };
  }, []);

  /*
   * How long the row wants to be.
   *
   * Only readable while it *is* a row — laid out as a column `scrollWidth` is
   * the column's width — so the last row reading is kept and reused to decide
   * when there is room to go back. `scrollWidth` rather than the box, because
   * the island has a `max-width` and the whole question is what it wants.
   */
  useLayoutEffect(() => {
    const row = rowRef.current;
    const root = toolbarRootRef.current;
    if (!row || !root) return;
    if (axis === "column") return;
    const publish = () => {
      const chrome = Math.max(0, root.offsetWidth - row.clientWidth);
      const next = Math.ceil(row.scrollWidth + chrome);
      if (next < 32) return;
      setRowWidth((was) => (Math.abs(was - next) <= 1 ? was : next));
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(row);
    return () => observer.disconnect();
  }, [axis]);

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
      rowWidth,
    );
    const extraLeft = nextAxis === "column" ? TOOLBAR_LEFT_CHROME_INSET_PX : 0;
    const next = clampFloatingPos(tentative.x, tentative.y, drag.width, drag.height, extraLeft);
    setLayout({ mode: "floating", ...next });
    const anchor = dockAnchorRect(toolbarRootRef.current);
    if (anchor) {
      setDockNear(
        isNearDock(
          {
            left: next.x,
            top: next.y,
            right: next.x + drag.width,
            bottom: next.y + drag.height,
          },
          anchor,
        ),
      );
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
    let shouldDock = false;
    let dockX = curX;
    let dockY = curY;
    if (anchor) {
      const ax = anchor.left + Math.max(anchor.width, 1) / 2;
      const ay = anchor.top + Math.max(12, anchor.height / 2);
      shouldDock = isNearDock(
        { left: curX, top: curY, right: curX + width, bottom: curY + height },
        anchor,
      );
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
    /*
     * Select is a detour, so tapping it again comes back.
     *
     * Every other tool on this strip is somewhere you stay: you pick the pen
     * and you write. Select is somewhere you go to move one thing and then
     * want out of, and there was no "out" — the only way back to the pen was to
     * find the pen, which is a different button in a different place from the
     * one your finger is already on. Pressing the lit button to leave the mode
     * it lit is what a toggle means.
     */
    if (tool === "selection" && active === "selection" && !shapesUiActive) {
      onPick("freedraw");
      return;
    }
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
        flyoutSide === "left" ? "is-flyout-left" : "",
        flyoutSide === "right" ? "is-flyout-right" : "",
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
      <div className="lc-toolbar-row" ref={rowRef}>
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

        {markdown ? (
          <MarkdownTools onFormat={onMdFormat} />
        ) : (
        <>
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
            animateOnMount={!handover}
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
              ? `Reset ${resetClearModeLabel(resetMode)} locked — tap to switch mode, hold to unlock`
              : `Reset ${resetClearModeLabel(resetMode)} unlocked — tap to reset, hold to lock`
          }
          dataTip={
            resetLocked
              ? `Reset ${resetClearModeLabel(resetMode)} — tap to switch, hold to unlock`
              : `Reset ${resetClearModeLabel(resetMode)} — tap to reset, hold to lock`
          }
          dataTipPlacement="bottom"
          className={[
            "lc-tool lc-tip-target lc-hold-icon lc-reset-tool",
            resetLocked ? "is-locked" : "lc-hold-danger",
            `is-reset-${resetMode}`,
          ].join(" ")}
          pressed={!resetLocked}
          onConfirm={() => setResetLocked((locked) => !locked)}
          onTap={() => {
            if (resetLocked) {
              setResetMode((mode) => cycleResetClearMode(mode));
              return;
            }
            onReset(resetMode);
            setResetLocked(true);
          }}
        >
          <ResetIcon />
          <span className="lc-reset-mode-dots" aria-hidden>
            {(resetMode === "all" || resetMode === "ink") && (
              <i className="lc-reset-dot is-ink" />
            )}
            {(resetMode === "all" || resetMode === "annotations") && (
              <i className="lc-reset-dot is-annotations" />
            )}
          </span>
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
        </>
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
