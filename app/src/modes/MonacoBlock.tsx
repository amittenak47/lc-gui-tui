/**
 * The Monaco half of the pseudocode panel, kept in its own module so it can be
 * lazily imported.
 *
 * Monaco is ~4 MB. Loading it with the app would delay first paint of the
 * canvas, and ink latency in a WebView is the plan's top risk — so it is only
 * fetched when the student actually opens the pseudocode block.
 */

import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useEffect, useMemo, useRef } from "react";

// The package's exports map rewrites `./*` to `./esm/vs/*.js`, so this
// resolves to esm/vs/editor/editor.worker.js — spelling out the esm path here
// would double the prefix.
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";

import { APP_THEMES } from "../theme/appThemes";

/**
 * Point Monaco at the bundled copy.
 *
 * By default `@monaco-editor/react` fetches Monaco from a CDN at runtime, which
 * fails on the tablet: the app is LAN-only and the WebView's CSP blocks it.
 * Configuring the loader with the local import makes the editor work offline.
 */
loader.config({ monaco });

self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

const definedThemes = new Set<string>();

/** Base editor size at board zoom 1 — matches statement density on the canvas. */
const BASE_FONT_SIZE = 13;
const BASE_PADDING_TOP = 8;
const BASE_SCROLLBAR = 4;

function scaledFontSize(zoom: number): number {
  return Math.max(6, Math.round(BASE_FONT_SIZE * zoom * 10) / 10);
}

/** Mix a hex color toward black (darken) or white (lighten) by `amount` 0–1. */
function mixHex(hex: string, toward: "#000000" | "#ffffff", amount: number): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return hex;
  const channel = (index: number) => Number.parseInt(raw.slice(index, index + 2), 16);
  const target = toward === "#000000" ? 0 : 255;
  const mix = (value: number) => Math.round(value + (target - value) * amount);
  const toHex = (value: number) => mix(value).toString(16).padStart(2, "0");
  return `#${toHex(channel(0))}${toHex(channel(2))}${toHex(channel(4))}`;
}

function monacoThemeName(themeId: string): string {
  return `lc-code-${themeId}`;
}

function ensureMonacoTheme(themeId: string): string {
  const appTheme = APP_THEMES.find((candidate) => candidate.id === themeId) ?? APP_THEMES[0];
  const name = monacoThemeName(appTheme.id);
  if (definedThemes.has(name)) return name;

  const dark = appTheme.mode === "dark";
  const background = appTheme.background;
  const line = dark ? mixHex(background, "#ffffff", 0.08) : mixHex(background, "#000000", 0.05);
  const selection = dark ? mixHex(background, "#ffffff", 0.14) : mixHex(background, "#000000", 0.1);

  monaco.editor.defineTheme(name, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": background,
      "editorGutter.background": background,
      "editorLineNumber.foreground": appTheme.hint,
      "editorLineNumber.activeForeground": dark ? "#c8d0dc" : "#5b6478",
      "editor.lineHighlightBackground": line,
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": selection,
      "editor.inactiveSelectionBackground": selection,
      "editorCursor.foreground": dark ? "#f97316" : "#b45309",
      "editorWidget.background": appTheme.panel,
      "editorSuggestWidget.background": appTheme.panel,
      "scrollbarSlider.background": dark ? "#ffffff3d" : "#00000033",
      "scrollbarSlider.hoverBackground": dark ? "#ffffff55" : "#00000045",
      "scrollbarSlider.activeBackground": dark ? "#ffffff66" : "#00000055",
    },
  });
  definedThemes.add(name);
  return name;
}

export interface MonacoBlockProps {
  value: string;
  language: string;
  themeId?: string;
  /** Excalidraw zoom — font/padding track the board. */
  zoom?: number;
  height?: string;
  onChange: (value: string) => void;
  onReady: () => void;
}

export default function MonacoBlock({
  value,
  language,
  themeId = "parchment",
  zoom = 1,
  height = "min(42vh, 360px)",
  onChange,
  onReady,
}: MonacoBlockProps) {
  const monacoTheme = useMemo(() => ensureMonacoTheme(themeId), [themeId]);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const fontSize = scaledFontSize(zoom);
  const padTop = Math.max(2, Math.round(BASE_PADDING_TOP * zoom));
  const scrollbar = Math.max(2, Math.round(BASE_SCROLLBAR * zoom));

  useEffect(() => {
    ensureMonacoTheme(themeId);
    monaco.editor.setTheme(monacoThemeName(themeId));
  }, [themeId]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize,
      padding: { top: padTop },
      scrollbar: {
        verticalScrollbarSize: scrollbar,
        horizontalScrollbarSize: scrollbar,
      },
    });
  }, [fontSize, padTop, scrollbar]);

  return (
    <Editor
      height={height}
      language={language}
      theme={monacoTheme}
      value={value}
      onMount={(editor) => {
        editorRef.current = editor;
        ensureMonacoTheme(themeId);
        monaco.editor.setTheme(monacoThemeName(themeId));
        editor.updateOptions({
          fontSize,
          padding: { top: padTop },
          scrollbar: {
            verticalScrollbarSize: scrollbar,
            horizontalScrollbarSize: scrollbar,
          },
        });
        onReady();
        editor.layout();
      }}
      onChange={(next) => onChange(next ?? "")}
      options={{
        minimap: { enabled: false },
        lineNumbers: "on",
        fontSize,
        fontFamily: "Consolas, 'Cascadia Code', 'Courier New', monospace",
        scrollBeyondLastLine: false,
        wordWrap: "on",
        tabSize: 4,
        renderLineHighlight: "line",
        overviewRulerLanes: 0,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        padding: { top: padTop },
        // Thin overlay thumb — closer to iOS than Monaco's default gutter bar.
        scrollbar: {
          verticalScrollbarSize: scrollbar,
          horizontalScrollbarSize: scrollbar,
          arrowSize: 0,
          useShadows: false,
          verticalHasArrows: false,
          horizontalHasArrows: false,
        },
        // A stylus can't easily dismiss an autocomplete popup.
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        automaticLayout: true,
      }}
    />
  );
}
