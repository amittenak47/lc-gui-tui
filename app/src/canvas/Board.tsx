/**
 * The Excalidraw canvas, wrapped so nothing above it depends on Excalidraw.
 *
 * `@excalidraw/excalidraw` is a plain React component — only excalidraw.com's
 * wrapper is Electron — so it mounts straight into the Tauri WebView.
 *
 * Excalidraw's own chrome is hidden (see `.lc-board` in styles.css) and replaced
 * by {@link BoardToolbar}: pen, eraser, text, shapes, undo, clear, plus font
 * size and board background. A stylus session should never need a menu, and
 * everything that changes what the pen does lives in one strip beside the pen.
 */

import { CaptureUpdateAction, Excalidraw, convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  SHAPES,
  SHAPE_GROUPS,
  resolveShapeMods,
  DEFAULT_SHAPE_PALETTE,
  type ShapeModValue,
  type ShapeStamp,
} from "../templates/shapes";
import {
  loadImportedLibrary,
  parseExcalidrawLibrary,
  placeImportedElements,
  saveImportedLibrary,
  type ImportedLibraryItem,
} from "../templates/libraryImport";
import { regionFrameId, syncRegionLayout, type LayoutElement } from "../templates/regionLayout";
import { REGIONS } from "../templates/regions";
import {
  BOARD_THEMES,
  DEFAULT_FONT_SIZE,
  FONT_SIZES,
  FONT_UI,
  type Skeleton,
} from "../templates/skeleton";
import { BackgroundPalette } from "../components/BackgroundPalette";
import { isDarkTheme } from "../theme/appThemes";
import type { BoardHandle, ScreenRect, ToolName } from "./BoardHandle";
import { captureImage, captureStrokes, type SceneElementLike } from "./capture";
import { applyMetadata, keepOnClear } from "./scene";

/**
 * The slice of Excalidraw's imperative API this file uses, declared locally so a
 * version bump can't break the build over a type path.
 */
interface ExcalidrawApi {
  getSceneElements(): readonly unknown[];
  getAppState(): Record<string, unknown>;
  getFiles(): Record<string, unknown>;
  updateScene(scene: {
    elements?: unknown[];
    appState?: Record<string, unknown>;
    captureUpdate?:
      | typeof CaptureUpdateAction.NEVER
      | typeof CaptureUpdateAction.IMMEDIATELY
      | typeof CaptureUpdateAction.EVENTUALLY;
  }): void;
  setActiveTool(tool: { type: string }): void;
  setCursor?(cursor: string): void;
  resetCursor?(): void;
  scrollToContent(target?: unknown, opts?: unknown): void;
  onScrollChange?(
    callback: (scrollX: number, scrollY: number, zoom: { value: number }) => void,
  ): () => void;
  history?: { clear(): void };
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.15;

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/** Pink rubber eraser cursor; size tracks Thin / Bold / Heavy. */
function eraserCursorCss(strokeWidth: number): string {
  const px = strokeWidth <= 1 ? 18 : strokeWidth <= 2 ? 26 : 36;
  const svg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24">` +
      `<g transform="rotate(-28 12 12)">` +
      `<rect x="5" y="7" width="14" height="10" rx="2" fill="#f9a8d4" stroke="#be185d" stroke-width="1.2"/>` +
      `<rect x="5" y="7" width="14" height="3.5" rx="1" fill="#fda4af"/>` +
      `<rect x="5" y="14.5" width="14" height="2.5" fill="#fff1f2" opacity="0.9"/>` +
      `</g></svg>`,
  );
  const hot = Math.round(px / 2);
  return `url("data:image/svg+xml,${svg}") ${hot} ${hot}, crosshair`;
}

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Excalidraw only handles undo/redo when its key handler runs — not via a fake API. */
function triggerUndo(): void {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      code: "KeyZ",
      bubbles: true,
      cancelable: true,
      ...(isMac ? { metaKey: true } : { ctrlKey: true }),
    }),
  );
}

function triggerRedo(): void {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      code: "KeyZ",
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      ...(isMac ? { metaKey: true } : { ctrlKey: true }),
    }),
  );
}

export interface BoardProps {
  /** Called whenever the scene changes, so the ambient loop can sample it. */
  onChange?: () => void;
  themeId: string;
  onThemePick?: (id: string) => void;
  /** False on the problem browser — canvas is read-only and tools are hidden. */
  interactive?: boolean;
  /** Screen rect of the solution-code region, updated as you pan/zoom/resize. */
  onCodeSlot?: (rect: ScreenRect | null) => void;
}

const STROKE_WIDTHS = [
  { value: 1, label: "Thin" },
  { value: 2, label: "Bold" },
  { value: 4, label: "Heavy" },
] as const;

const INK_COLORS_LIGHT = ["#1e1e1e", "#64748b", "#b45309", "#1d4ed8", "#166534", "#b91c1c"] as const;
const INK_COLORS_DARK = ["#f3f4f6", "#94a3b8", "#fb923c", "#60a5fa", "#4ade80", "#f87171"] as const;

function defaultInk(themeId: string): string {
  return isDarkTheme(themeId) ? INK_COLORS_DARK[0] : INK_COLORS_LIGHT[0];
}

function inkSwatches(themeId: string): readonly string[] {
  return isDarkTheme(themeId) ? INK_COLORS_DARK : INK_COLORS_LIGHT;
}

const TOOLS: Array<{ tool: ToolName; label: string; hint: string; emoji?: string }> = [
  { tool: "hand", label: "hand", hint: "Pan — drag to move around the board", emoji: "✋" },
  { tool: "selection", label: "⬚", hint: "Select — resize region boxes or move your work" },
  { tool: "freedraw", label: "Pen", hint: "Pen", emoji: "✏️" },
  { tool: "eraser", label: "Eraser", hint: "Eraser", emoji: "erasersvg" },
  { tool: "text", label: "T", hint: "Text" },
  { tool: "rectangle", label: "▭", hint: "Rectangle" },
  { tool: "ellipse", label: "◯", hint: "Ellipse" },
  { tool: "arrow", label: "↗", hint: "Arrow" },
];

/** Stable across renders — a fresh object makes Excalidraw thrash its tunnel store. */
const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: false,
    toggleTheme: false,
  },
  tools: { image: false },
} as const;

function roundPx(value: number): number {
  return Math.round(value);
}

function sameCodeSlot(a: ScreenRect | null, b: ScreenRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

export const Board = forwardRef<BoardHandle, BoardProps>(function Board(
  { onChange, themeId, onThemePick, interactive = true, onCodeSlot },
  ref,
) {
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const [activeTool, setActiveTool] = useState<ToolName>("hand");
  const [fontSize, setFontSizeState] = useState<number>(DEFAULT_FONT_SIZE);
  const [inkColor, setInkColor] = useState(() => defaultInk(themeId));
  const [strokeWidth, setStrokeWidthState] = useState(1);
  const [shapesOpen, setShapesOpen] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const templateRef = useRef<unknown[]>([]);
  const seedSkeletonsRef = useRef<Skeleton[]>([]);
  const scrollUnsubRef = useRef<(() => void) | null>(null);
  const layoutSyncingRef = useRef(false);
  const lastCodeSlotRef = useRef<ScreenRect | null>(null);
  const onCodeSlotRef = useRef(onCodeSlot);
  onCodeSlotRef.current = onCodeSlot;

  const elements = useCallback((): SceneElementLike[] => {
    return (apiRef.current?.getSceneElements() ?? []) as SceneElementLike[];
  }, []);

  const reportCodeSlot = useCallback(() => {
    const api = apiRef.current;
    const notify = onCodeSlotRef.current;
    if (!api || !notify) return;

    const frame = (api.getSceneElements() as LayoutElement[]).find(
      (element) =>
        element.type === "rectangle" &&
        (element.id === regionFrameId("code") ||
          (element.customData?.lcRegion === "code" && element.customData?.lcRegionFrame)),
    );
    if (!frame) {
      if (lastCodeSlotRef.current !== null) {
        lastCodeSlotRef.current = null;
        notify(null);
      }
      return;
    }

    const state = api.getAppState() as {
      scrollX?: number;
      scrollY?: number;
      zoom?: { value?: number };
      width?: number;
      height?: number;
    };
    const zoom = state.zoom?.value ?? 1;
    const scrollX = state.scrollX ?? 0;
    const scrollY = state.scrollY ?? 0;
    // Overlay is positioned inside `.lc-canvas-wrap`, which matches the Excalidraw
    // viewport — do not add page offsets (those are for clientX/clientY only).
    const inset = Math.max(6, Math.round(8 * zoom));
    const next: ScreenRect = {
      left: roundPx((frame.x + scrollX) * zoom + inset),
      top: roundPx((frame.y + scrollY) * zoom + inset),
      width: roundPx(Math.max(0, num(frame.width, REGIONS.code.w) * zoom - inset * 2)),
      height: roundPx(Math.max(0, num(frame.height, REGIONS.code.h) * zoom - inset * 2)),
    };

    // Hide the dock when the code frame is fully off-screen — switching to the
    // fallback absolute slot caused a visible snap while panning past the box.
    const viewH = typeof state.height === "number" ? state.height : 0;
    const viewW = typeof state.width === "number" ? state.width : 0;
    const offscreen =
      next.top + next.height < -40 ||
      next.top > viewH + 40 ||
      next.left + next.width < -40 ||
      next.left > viewW + 40 ||
      next.width < 24 ||
      next.height < 24;
    if (offscreen) {
      if (lastCodeSlotRef.current !== null) {
        lastCodeSlotRef.current = null;
        notify(null);
      }
      return;
    }

    // New object every frame would re-render App → resize Excalidraw → onChange
    // → report again ("Maximum update depth exceeded").
    if (sameCodeSlot(lastCodeSlotRef.current, next)) return;
    lastCodeSlotRef.current = next;
    notify(next);
  }, []);

  const setStrokeWidth = useCallback((width: number) => {
    setStrokeWidthState(width);
    apiRef.current?.updateScene({ appState: { currentItemStrokeWidth: width } });
    if (activeTool === "eraser") {
      apiRef.current?.setCursor?.(eraserCursorCss(width));
    }
  }, [activeTool]);

  const setTool = useCallback((tool: ToolName) => {
    apiRef.current?.setActiveTool({ type: tool });
    setActiveTool(tool);
    if (tool === "eraser") {
      apiRef.current?.setCursor?.(eraserCursorCss(strokeWidth));
    } else {
      apiRef.current?.resetCursor?.();
    }
  }, [strokeWidth]);

  /**
   * Turn skeletons into elements, then stamp the metadata back on — bound
   * labels get generated ids and would otherwise lose their region/viz tag.
   */
  const convert = useCallback((skeletons: Skeleton[]): unknown[] => {
    const converted = convertToExcalidrawElements(skeletons as never) as unknown[];
    return applyMetadata(converted as never, skeletons);
  }, []);

  const setFontSize = useCallback((size: number) => {
    setFontSizeState(size);
    apiRef.current?.updateScene({ appState: { currentItemFontSize: size } });
  }, []);

  const setInk = useCallback((color: string) => {
    setInkColor(color);
    apiRef.current?.updateScene({ appState: { currentItemStrokeColor: color } });
  }, []);

  useEffect(() => {
    const theme = BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];
    const ink = defaultInk(themeId);
    setInkColor(ink);
    apiRef.current?.updateScene({
      appState: {
        viewBackgroundColor: theme.background,
        currentItemStrokeColor: ink,
      },
    });
  }, [themeId]);

  const readZoom = useCallback(() => {
    const state = apiRef.current?.getAppState() as { zoom?: { value?: number } } | undefined;
    return state?.zoom?.value ?? 1;
  }, []);

  const setZoom = useCallback(
    (next: number) => {
      const clamped = clampZoom(next);
      apiRef.current?.updateScene({ appState: { zoom: { value: clamped } } });
      setZoomPct(Math.round(clamped * 100));
      requestAnimationFrame(reportCodeSlot);
    },
    [reportCodeSlot],
  );

  const zoomIn = useCallback(() => setZoom(readZoom() * ZOOM_STEP), [readZoom, setZoom]);
  const zoomOut = useCallback(() => setZoom(readZoom() / ZOOM_STEP), [readZoom, setZoom]);

  const fitView = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const template = templateRef.current as Array<{
      customData?: { lcRegion?: string } | null;
    }>;
    // Prefer the problem statement + code slot so the statement stays readable.
    // Full-board fit zooms out too far and makes the statement tiny.
    const focus = template.filter((element) => {
      const region = element.customData?.lcRegion;
      return region === "constraints" || region === "code";
    });
    const target =
      focus.length > 0
        ? focus
        : template.length > 0
          ? template
          : (api.getSceneElements?.() ?? []);
    api.scrollToContent(target, {
      fitToViewport: true,
      viewportZoomFactor: 0.92,
      animate: false,
    });
    setZoomPct(Math.round(readZoom() * 100));
    requestAnimationFrame(reportCodeSlot);
  }, [readZoom, reportCodeSlot]);

  /** Run fit after Excalidraw has applied scene + container size. */
  const scheduleFitView = useCallback(() => {
    const run = () => fitView();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        run();
        window.setTimeout(run, 60);
        window.setTimeout(run, 200);
      });
    });
  }, [fitView]);

  /** Drop a configured stamp near the middle of what's currently on screen. */
  const stamp = useCallback(
    (shape: ShapeStamp, mods: Record<string, ShapeModValue>, moveAsOne: boolean) => {
      const api = apiRef.current;
      if (!api) return;
      const state = api.getAppState() as {
        scrollX?: number;
        scrollY?: number;
        width?: number;
        height?: number;
        zoom?: { value?: number };
      };
      const zoom = state.zoom?.value ?? 1;
      const x = Math.round(-(state.scrollX ?? 0) + (state.width ?? 1200) / (2 * zoom) - 200);
      const y = Math.round(-(state.scrollY ?? 0) + (state.height ?? 800) / (2 * zoom) - 100);
      const resolved = resolveShapeMods(shape, mods);
      // Fixed sketch palette — stamps do not follow Appearance.
      let pieces = convert(shape.build(x, y, resolved, DEFAULT_SHAPE_PALETTE)) as Array<{
        id: string;
        groupIds?: string[];
        customData?: Record<string, unknown> | null;
        [key: string]: unknown;
      }>;

      if (moveAsOne && pieces.length > 1) {
        const groupId = `lcstamp-${shape.id}-${Date.now().toString(36)}`;
        pieces = pieces.map((element) => ({
          ...element,
          groupIds: [...(element.groupIds ?? []), groupId],
          customData: {
            ...(element.customData ?? {}),
            lcStamp: true,
            lcStampGroup: groupId,
          },
        }));
      }

      // IMMEDIATELY so Undo/Redo include library stamps (Server, Array, …).
      api.updateScene({
        elements: [...(api.getSceneElements() as unknown[]), ...pieces],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      setShapesOpen(false);
      setTool("selection");
    },
    [convert, setTool],
  );

  const stampImported = useCallback(
    (item: ImportedLibraryItem, moveAsOne: boolean) => {
      const api = apiRef.current;
      if (!api) return;
      const state = api.getAppState() as {
        scrollX?: number;
        scrollY?: number;
        width?: number;
        height?: number;
        zoom?: { value?: number };
      };
      const zoom = state.zoom?.value ?? 1;
      const x = Math.round(-(state.scrollX ?? 0) + (state.width ?? 1200) / (2 * zoom) - 200);
      const y = Math.round(-(state.scrollY ?? 0) + (state.height ?? 800) / (2 * zoom) - 100);
      const pieces = placeImportedElements(item.elements, x, y, moveAsOne);
      api.updateScene({
        elements: [...(api.getSceneElements() as unknown[]), ...pieces],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      setShapesOpen(false);
      setTool("selection");
    },
    [setTool],
  );

  // Excalidraw can reset the active tool during its own mount; re-assert the
  // default once the API is live so a session starts in pan mode, not drawing.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (apiRef.current && activeTool === "hand") {
        apiRef.current.setActiveTool({ type: "hand" });
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [activeTool]);

  const resetTemplate = useCallback(() => {
    const skeletons = seedSkeletonsRef.current;
    if (skeletons.length === 0) return;
    const converted = convert(skeletons);
    templateRef.current = converted;
    apiRef.current?.updateScene({
      elements: converted,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    requestAnimationFrame(() => {
      scheduleFitView();
    });
  }, [convert, scheduleFitView]);

  const handleSceneChange = useCallback(() => {
    const api = apiRef.current;
    if (api && !layoutSyncingRef.current) {
      const synced = syncRegionLayout(api.getSceneElements() as LayoutElement[]);
      if (synced) {
        // Hold the guard through the synchronous onChange that updateScene may
        // re-enter with; clear on the next frame. Avoid delayed re-sync timers —
        // those snapped the viewport while panning past the code dock.
        layoutSyncingRef.current = true;
        api.updateScene({
          elements: synced,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        requestAnimationFrame(() => {
          layoutSyncingRef.current = false;
        });
      }
    }
    reportCodeSlot();
    onChange?.();
  }, [onChange, reportCodeSlot]);

  useImperativeHandle(
    ref,
    (): BoardHandle => ({
      getElements: elements,
      setElements: (next) => apiRef.current?.updateScene({ elements: next }),
      convert,
      seedTemplate: (skeletons: Skeleton[]) => {
        seedSkeletonsRef.current = skeletons;
        const converted = convert(skeletons);
        templateRef.current = converted;
        apiRef.current?.updateScene({
          elements: converted,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        // Clear history after seeding so Ctrl+Z undoes student strokes, not the
        // empty board from before the problem loaded.
        requestAnimationFrame(() => {
          apiRef.current?.history?.clear();
          scheduleFitView();
        });
      },
      clearStudentWork: () => {
        // Keep the template and the coach's diagrams; drop only what the
        // student drew. Membership comes from `customData`, which survives
        // conversion — matching on id prefixes did not, which is why this used
        // to wipe the problem statement.
        apiRef.current?.updateScene({
          elements: elements().filter(keepOnClear) as unknown[],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      },
      resetTemplate,
      exportPng: async () => {
        const api = apiRef.current;
        if (!api) return "";
        return captureImage(async () =>
          exportToBlob({
            elements: api.getSceneElements() as never,
            appState: api.getAppState() as never,
            files: api.getFiles() as never,
            mimeType: "image/png",
            quality: 0.8,
          }),
        );
      },
      getStrokes: () => captureStrokes(elements()),
      setTool,
      undo: () => {
        triggerUndo();
      },
      scrollToContent: () => apiRef.current?.scrollToContent(),
      zoomIn,
      zoomOut,
      fitView,
    }),
    [convert, elements, fitView, resetTemplate, scheduleFitView, setTool, zoomIn, zoomOut],
  );

  const theme = BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];

  const initialData = useMemo(
    () => ({
      appState: {
        viewBackgroundColor: theme.background,
        currentItemStrokeColor: defaultInk(themeId),
        currentItemStrokeWidth: 1,
        currentItemRoughness: 1,
        // Not the hand-drawn default: typed notes should read like notes.
        currentItemFontFamily: FONT_UI,
        currentItemFontSize: DEFAULT_FONT_SIZE,
      },
      scrollToContent: true,
    }),
    [theme.background, themeId],
  );

  return (
    <div className={interactive ? "lc-board" : "lc-board lc-board-idle"}>
      {interactive && (
        <>
          <BoardToolbar
            active={activeTool}
            onPick={setTool}
            themeId={themeId}
            inkColor={inkColor}
            onInk={setInk}
            strokeWidth={strokeWidth}
            onStrokeWidth={setStrokeWidth}
            fontSize={fontSize}
            onFontSize={setFontSize}
            shapesOpen={shapesOpen}
            onToggleShapes={() => setShapesOpen((open) => !open)}
            onStamp={stamp}
            onStampImported={stampImported}
            onClear={() =>
              apiRef.current?.updateScene({
                elements: elements().filter(keepOnClear) as unknown[],
                captureUpdate: CaptureUpdateAction.IMMEDIATELY,
              })
            }
            onReset={resetTemplate}
            onUndo={triggerUndo}
            onRedo={triggerRedo}
          />
          <div className="lc-map-controls">
            {onThemePick && (
              <BackgroundPalette variant="map" themeId={themeId} onPick={onThemePick} />
            )}
            <ZoomControls
              zoomPct={zoomPct}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onFit={fitView}
            />
          </div>
        </>
      )}
      <Excalidraw
        viewModeEnabled={!interactive}
        handleKeyboardGlobally={interactive}
        excalidrawAPI={(api: unknown) => {
          apiRef.current = api as ExcalidrawApi;
          scrollUnsubRef.current?.();
          scrollUnsubRef.current =
            apiRef.current.onScrollChange?.((_x, _y, zoom) => {
              const pct = Math.round(zoom.value * 100);
              setZoomPct((current) => (current === pct ? current : pct));
              reportCodeSlot();
            }) ?? null;
          const state = apiRef.current.getAppState() as { zoom?: { value?: number } };
          const pct = Math.round((state.zoom?.value ?? 1) * 100);
          setZoomPct((current) => (current === pct ? current : pct));
          apiRef.current.setActiveTool({ type: "hand" });
          reportCodeSlot();
        }}
        onChange={handleSceneChange}
        initialData={initialData}
        UIOptions={UI_OPTIONS}
      />
    </div>
  );
});

interface ToolbarProps {
  active: ToolName;
  onPick: (tool: ToolName) => void;
  themeId: string;
  inkColor: string;
  onInk: (color: string) => void;
  strokeWidth: number;
  onStrokeWidth: (width: number) => void;
  fontSize: number;
  onFontSize: (size: number) => void;
  shapesOpen: boolean;
  onToggleShapes: () => void;
  onStamp: (shape: ShapeStamp, mods: Record<string, ShapeModValue>, moveAsOne: boolean) => void;
  onStampImported: (item: ImportedLibraryItem, moveAsOne: boolean) => void;
  onClear: () => void;
  onReset: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

function BoardToolbar({
  active,
  onPick,
  themeId,
  inkColor,
  onInk,
  strokeWidth,
  onStrokeWidth,
  fontSize,
  onFontSize,
  shapesOpen,
  onToggleShapes,
  onStamp,
  onStampImported,
  onClear,
  onReset,
  onUndo,
  onRedo,
}: ToolbarProps) {
  const showInk =
    active === "freedraw" ||
    active === "rectangle" ||
    active === "ellipse" ||
    active === "arrow" ||
    active === "text";
  const showStrokeSizes = showInk || active === "eraser";
  const [configuring, setConfiguring] = useState<ShapeStamp | null>(null);
  const [configuringImport, setConfiguringImport] = useState<ImportedLibraryItem | null>(null);
  const [mods, setMods] = useState<Record<string, ShapeModValue>>({});
  const [moveAsOne, setMoveAsOne] = useState(true);
  const [shapePhase, setShapePhase] = useState<"list" | "fade" | "mod">("list");
  const [imported, setImported] = useState<ImportedLibraryItem[]>(() => loadImportedLibrary());
  const [importError, setImportError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!shapesOpen) {
      setConfiguring(null);
      setConfiguringImport(null);
      setMods({});
      setShapePhase("list");
      setImportError(null);
    }
  }, [shapesOpen]);

  const pickShape = (shape: ShapeStamp) => {
    setConfiguring(shape);
    setConfiguringImport(null);
    setMods({ ...shape.defaults });
    setMoveAsOne(true);
    setShapePhase("fade");
    window.setTimeout(() => setShapePhase("mod"), 200);
  };

  const pickImported = (item: ImportedLibraryItem) => {
    setConfiguring(null);
    setConfiguringImport(item);
    setMods({});
    setMoveAsOne(true);
    setShapePhase("fade");
    window.setTimeout(() => setShapePhase("mod"), 200);
  };

  const backToList = () => {
    setShapePhase("list");
    setConfiguring(null);
    setConfiguringImport(null);
    setMods({});
  };

  const placeConfigured = () => {
    if (configuring) {
      onStamp(configuring, mods, moveAsOne);
    } else if (configuringImport) {
      onStampImported(configuringImport, moveAsOne);
    }
    backToList();
  };

  const onImportFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const items = parseExcalidrawLibrary(text);
      setImported((current) => {
        const merged = [...current];
        for (const item of items) {
          if (!merged.some((existing) => existing.id === item.id)) merged.push(item);
        }
        saveImportedLibrary(merged);
        return merged;
      });
      setImportError(null);
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const clearImported = () => {
    setImported([]);
    saveImportedLibrary([]);
  };

  const modifierTitle = configuring?.label ?? configuringImport?.name ?? "";

  return (
    <div className="lc-toolbar" role="toolbar" aria-label="Drawing tools">
      {TOOLS.map(({ tool, label, hint, emoji }) => (
        <button
          key={tool}
          type="button"
          className={tool === active ? "lc-tool lc-tool-active" : "lc-tool"}
          title={hint}
          aria-label={hint}
          aria-pressed={tool === active}
          onClick={() => onPick(tool)}
        >
          {emoji === "erasersvg" ? (
            <PinkEraserIcon />
          ) : emoji ? (
            <span className="lc-tool-emoji" aria-hidden>
              {emoji}
            </span>
          ) : (
            label
          )}
        </button>
      ))}

      {showInk && (
        <>
          <div className="lc-tool-sep" />
          <div className="lc-tool-group lc-ink-colors" role="group" aria-label="Ink colour">
            {inkSwatches(themeId).map((color) => (
              <button
                key={color}
                type="button"
                className={
                  color === inkColor
                    ? "lc-ink-swatch lc-ink-swatch-active lc-tip-target"
                    : "lc-ink-swatch lc-tip-target"
                }
                style={{ background: color }}
                data-tip="Ink colour"
                data-tip-placement="right"
                aria-label={`Ink ${color}`}
                aria-pressed={color === inkColor}
                onClick={() => onInk(color)}
              />
            ))}
          </div>
        </>
      )}

      {showStrokeSizes && (
        <>
          {!showInk && <div className="lc-tool-sep" />}
          <div className="lc-tool-group" role="group" aria-label={active === "eraser" ? "Eraser size" : "Stroke weight"}>
            {STROKE_WIDTHS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={
                  value === strokeWidth
                    ? "lc-tool lc-tool-mini lc-tool-active lc-tip-target"
                    : "lc-tool lc-tool-mini lc-tip-target"
                }
                data-tip={active === "eraser" ? `${label} eraser` : `${label} stroke`}
                data-tip-placement="right"
                title={label}
                aria-label={label}
                aria-pressed={value === strokeWidth}
                onClick={() => onStrokeWidth(value)}
              >
                <span className="lc-stroke-preview" style={{ height: Math.min(value + 1, 5) }} />
              </button>
            ))}
          </div>
        </>
      )}

      {active === "text" && (
        <div className="lc-tool-group" role="group" aria-label="Font size">
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={
                size === fontSize
                  ? "lc-tool lc-tool-mini lc-tool-active lc-tip-target"
                  : "lc-tool lc-tool-mini lc-tip-target"
              }
              data-tip={`Font size ${size}`}
              data-tip-placement="right"
              title={`Font size ${size}`}
              aria-pressed={size === fontSize}
              onClick={() => onFontSize(size)}
            >
              {size}
            </button>
          ))}
        </div>
      )}

      <div className="lc-tool-sep" />

      <button
        type="button"
        className={shapesOpen ? "lc-tool lc-tool-active" : "lc-tool"}
        title="Shapes — data structures and system design"
        aria-label="Shapes"
        aria-expanded={shapesOpen}
        onClick={onToggleShapes}
      >
        ⬡
      </button>

      <button type="button" className="lc-tool lc-tool-labeled" title="Undo" aria-label="Undo" onClick={onUndo}>
        <UndoIcon />
        <span className="lc-tool-caption">Undo</span>
      </button>
      <button type="button" className="lc-tool lc-tool-labeled" title="Redo" aria-label="Redo" onClick={onRedo}>
        <RedoIcon />
        <span className="lc-tool-caption">Redo</span>
      </button>

      {/* Clear lives with the drawing tools, not in the header — it changes the
          canvas, so it belongs beside the things that change the canvas. */}
      <button
        type="button"
        className="lc-tool lc-tool-danger lc-tool-labeled"
        title="Clear your work (keeps the problem and the coach's diagrams)"
        aria-label="Clear your work"
        onClick={onClear}
      >
        <ClearIcon />
        <span className="lc-tool-caption">Clear</span>
      </button>
      <button
        type="button"
        className="lc-tool lc-tool-labeled"
        title="Reset to the original problem layout"
        aria-label="Reset board"
        onClick={() => {
          if (
            window.confirm(
              "Reset the board to the original problem layout? Drawings on the canvas will be cleared.",
            )
          ) {
            onReset();
          }
        }}
      >
        <ResetIcon />
        <span className="lc-tool-caption">Reset</span>
      </button>

      {shapesOpen && (
        <div
          className={
            shapePhase === "mod" ? "lc-shapes lc-shapes-modifying" : "lc-shapes"
          }
          role="menu"
          aria-label="Shape library"
        >
          {shapePhase !== "mod" && (
            <>
              {SHAPE_GROUPS.map((group) => {
                const items =
                  group === "imported"
                    ? []
                    : SHAPES.filter((shape) => shape.group === group);
                if (group === "imported") {
                  if (imported.length === 0 && shapePhase === "list") {
                    return (
                      <div key={group} className="lc-shape-group">
                        <h4>{group}</h4>
                        <p className="lc-muted lc-shape-import-hint">
                          Import a local <code>.excalidrawlib</code> (download from libraries.excalidraw.com on another machine).
                        </p>
                      </div>
                    );
                  }
                  if (imported.length === 0) return null;
                  return (
                    <div key={group} className="lc-shape-group">
                      <h4>{group}</h4>
                      {imported.map((item) => {
                        const fading =
                          shapePhase === "fade" &&
                          configuringImport &&
                          configuringImport.id !== item.id;
                        const rising =
                          shapePhase === "fade" &&
                          configuringImport &&
                          configuringImport.id === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            role="menuitem"
                            className={
                              rising
                                ? "lc-shape lc-shape-rising"
                                : fading
                                  ? "lc-shape lc-shape-fade"
                                  : "lc-shape"
                            }
                            onClick={() => pickImported(item)}
                          >
                            {item.name}
                          </button>
                        );
                      })}
                    </div>
                  );
                }

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

              <div className="lc-shape-import-row">
                <input
                  ref={importRef}
                  type="file"
                  accept=".excalidrawlib,application/json"
                  hidden
                  onChange={(event) => {
                    void onImportFile(event.target.files?.[0] ?? null);
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="lc-secondary lc-shape-import"
                  onClick={() => importRef.current?.click()}
                >
                  Import library…
                </button>
                {imported.length > 0 && (
                  <button type="button" className="lc-link" onClick={clearImported}>
                    Clear imports
                  </button>
                )}
              </div>
              {importError && <p className="lc-warning">{importError}</p>}
            </>
          )}

          {shapePhase === "mod" && (configuring || configuringImport) && (
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
                  <strong>Lock as one piece</strong>
                  <span className="lc-muted">
                    {" "}
                    — on: drag the whole stamp; off: move parts separately
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

function ClearIcon() {
  return (
    <svg className="lc-tool-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 6h18"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 6V4h8v2"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M10 11v6M14 11v6"
      />
    </svg>
  );
}

function ZoomControls({
  zoomPct,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  zoomPct: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  return (
    <div className="lc-zoom" role="group" aria-label="Zoom">
      <button
        type="button"
        className="lc-map-btn"
        data-tip="Zoom in"
        data-tip-placement="left"
        aria-label="Zoom in"
        onClick={onZoomIn}
      >
        +
      </button>
      <button
        type="button"
        className="lc-map-btn"
        data-tip="Zoom out"
        data-tip-placement="left"
        aria-label="Zoom out"
        onClick={onZoomOut}
      >
        −
      </button>
      <button
        type="button"
        className="lc-map-btn"
        data-tip={`Center view (${zoomPct}%)`}
        data-tip-placement="left"
        aria-label={`Center view, ${zoomPct}% zoom`}
        onClick={onFit}
      >
        ⊡
      </button>
    </div>
  );
}