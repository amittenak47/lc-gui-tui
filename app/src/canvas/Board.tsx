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

import { Excalidraw, convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { SHAPES, SHAPE_GROUPS, type ShapeStamp } from "../templates/shapes";
import {
  BOARD_THEMES,
  DEFAULT_FONT_SIZE,
  FONT_SIZES,
  FONT_UI,
  type Skeleton,
} from "../templates/skeleton";
import type { BoardHandle, ToolName } from "./BoardHandle";
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
  updateScene(scene: { elements?: unknown[]; appState?: Record<string, unknown> }): void;
  setActiveTool(tool: { type: string }): void;
  scrollToContent(target?: unknown, opts?: unknown): void;
  history?: { clear(): void };
}

export interface BoardProps {
  /** Called whenever the scene changes, so the ambient loop can sample it. */
  onChange?: () => void;
}

const TOOLS: Array<{ tool: ToolName; label: string; hint: string }> = [
  { tool: "freedraw", label: "✏️", hint: "Pen" },
  { tool: "eraser", label: "🩹", hint: "Eraser" },
  { tool: "text", label: "T", hint: "Text" },
  { tool: "rectangle", label: "▭", hint: "Rectangle" },
  { tool: "ellipse", label: "◯", hint: "Ellipse" },
  { tool: "arrow", label: "↗", hint: "Arrow" },
  { tool: "selection", label: "⬚", hint: "Select — for moving and resizing what you drew" },
];

export const Board = forwardRef<BoardHandle, BoardProps>(function Board({ onChange }, ref) {
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const [activeTool, setActiveTool] = useState<ToolName>("freedraw");
  const [fontSize, setFontSizeState] = useState<number>(DEFAULT_FONT_SIZE);
  const [themeId, setThemeId] = useState(BOARD_THEMES[0].id);
  const [shapesOpen, setShapesOpen] = useState(false);

  const elements = useCallback((): SceneElementLike[] => {
    return (apiRef.current?.getSceneElements() ?? []) as SceneElementLike[];
  }, []);

  const setTool = useCallback((tool: ToolName) => {
    apiRef.current?.setActiveTool({ type: tool });
    setActiveTool(tool);
  }, []);

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

  const setTheme = useCallback((id: string) => {
    const theme = BOARD_THEMES.find((candidate) => candidate.id === id) ?? BOARD_THEMES[0];
    setThemeId(theme.id);
    apiRef.current?.updateScene({ appState: { viewBackgroundColor: theme.background } });
  }, []);

  /** Drop a stamp near the middle of what's currently on screen. */
  const stamp = useCallback(
    (shape: ShapeStamp) => {
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

      api.updateScene({
        elements: [...(api.getSceneElements() as unknown[]), ...convert(shape.build(x, y))],
      });
      setShapesOpen(false);
      setTool("selection");
    },
    [convert, setTool],
  );

  // Excalidraw can reset the active tool during its own mount; re-assert the pen
  // once the API is live so a stylus session starts drawing, not selecting.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (apiRef.current && activeTool === "freedraw") {
        apiRef.current.setActiveTool({ type: "freedraw" });
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [activeTool]);

  useImperativeHandle(
    ref,
    (): BoardHandle => ({
      getElements: elements,
      setElements: (next) => apiRef.current?.updateScene({ elements: next }),
      convert,
      seedTemplate: (skeletons: Skeleton[]) => {
        apiRef.current?.updateScene({ elements: convert(skeletons) });
        apiRef.current?.history?.clear();
        apiRef.current?.scrollToContent();
      },
      clearStudentWork: () => {
        // Keep the template and the coach's diagrams; drop only what the
        // student drew. Membership comes from `customData`, which survives
        // conversion — matching on id prefixes did not, which is why this used
        // to wipe the problem statement.
        apiRef.current?.updateScene({ elements: elements().filter(keepOnClear) as unknown[] });
      },
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
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
        );
      },
      scrollToContent: () => apiRef.current?.scrollToContent(),
    }),
    [convert, elements, setTool],
  );

  const theme = BOARD_THEMES.find((candidate) => candidate.id === themeId) ?? BOARD_THEMES[0];

  return (
    <div className="lc-board">
      <BoardToolbar
        active={activeTool}
        onPick={setTool}
        fontSize={fontSize}
        onFontSize={setFontSize}
        themeId={themeId}
        onTheme={setTheme}
        shapesOpen={shapesOpen}
        onToggleShapes={() => setShapesOpen((open) => !open)}
        onStamp={stamp}
        onClear={() =>
          apiRef.current?.updateScene({ elements: elements().filter(keepOnClear) as unknown[] })
        }
        onUndo={() =>
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
          )
        }
      />
      <Excalidraw
        excalidrawAPI={(api: unknown) => {
          apiRef.current = api as ExcalidrawApi;
          apiRef.current.setActiveTool({ type: "freedraw" });
        }}
        onChange={onChange}
        initialData={{
          appState: {
            viewBackgroundColor: theme.background,
            currentItemStrokeWidth: 1,
            currentItemRoughness: 1,
            // Not the hand-drawn default: typed notes should read like notes.
            currentItemFontFamily: FONT_UI,
            currentItemFontSize: DEFAULT_FONT_SIZE,
          },
          scrollToContent: true,
        }}
        UIOptions={{
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
        }}
      />
    </div>
  );
});

interface ToolbarProps {
  active: ToolName;
  onPick: (tool: ToolName) => void;
  fontSize: number;
  onFontSize: (size: number) => void;
  themeId: string;
  onTheme: (id: string) => void;
  shapesOpen: boolean;
  onToggleShapes: () => void;
  onStamp: (shape: ShapeStamp) => void;
  onClear: () => void;
  onUndo: () => void;
}

function BoardToolbar({
  active,
  onPick,
  fontSize,
  onFontSize,
  themeId,
  onTheme,
  shapesOpen,
  onToggleShapes,
  onStamp,
  onClear,
  onUndo,
}: ToolbarProps) {
  return (
    <div className="lc-toolbar" role="toolbar" aria-label="Drawing tools">
      {TOOLS.map(({ tool, label, hint }) => (
        <button
          key={tool}
          type="button"
          className={tool === active ? "lc-tool lc-tool-active" : "lc-tool"}
          title={hint}
          aria-label={hint}
          aria-pressed={tool === active}
          onClick={() => onPick(tool)}
        >
          {label}
        </button>
      ))}

      {active === "text" && (
        <div className="lc-tool-group" role="group" aria-label="Font size">
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={size === fontSize ? "lc-tool lc-tool-mini lc-tool-active" : "lc-tool lc-tool-mini"}
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

      <button type="button" className="lc-tool" title="Undo" aria-label="Undo" onClick={onUndo}>
        ↩
      </button>

      {/* Clear lives with the drawing tools, not in the header — it changes the
          canvas, so it belongs beside the things that change the canvas. */}
      <button
        type="button"
        className="lc-tool lc-tool-danger"
        title="Clear your work (keeps the problem and the coach's diagrams)"
        aria-label="Clear your work"
        onClick={onClear}
      >
        ⌫
      </button>

      <div className="lc-tool-sep" />

      <div className="lc-swatches" role="group" aria-label="Board background">
        {BOARD_THEMES.map((option) => (
          <button
            key={option.id}
            type="button"
            className={option.id === themeId ? "lc-swatch lc-swatch-active" : "lc-swatch"}
            style={{ background: option.background }}
            title={option.label}
            aria-label={`${option.label} background`}
            aria-pressed={option.id === themeId}
            onClick={() => onTheme(option.id)}
          />
        ))}
      </div>

      {shapesOpen && (
        <div className="lc-shapes" role="menu" aria-label="Shape library">
          {SHAPE_GROUPS.map((group) => (
            <div key={group} className="lc-shape-group">
              <h4>{group}</h4>
              {SHAPES.filter((shape) => shape.group === group).map((shape) => (
                <button
                  key={shape.id}
                  type="button"
                  role="menuitem"
                  className="lc-shape"
                  onClick={() => onStamp(shape)}
                >
                  {shape.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
