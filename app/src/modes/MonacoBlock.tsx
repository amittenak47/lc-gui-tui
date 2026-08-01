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
import { useIsMobile } from "../util/mobile";
import type { CodeFontSize } from "./codeFontSize";
import { codeFontPx } from "./codeFontSize";

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

const PAD_TOP = 8;
const SCROLLBAR = 4;

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

/**
 * Soft keyboards only autocorrect when the underlying textarea opts in.
 * Monaco never sets these; on tablets we ask the OS keyboard to help, knowing
 * it will still be spotty (Monaco is not a normal contenteditable field).
 */
function enableTabletKeyboardHelpers(editor: monaco.editor.IStandaloneCodeEditor): void {
  const root = editor.getDomNode();
  if (!root) return;
  for (const node of root.querySelectorAll("textarea")) {
    node.setAttribute("autocorrect", "on");
    node.setAttribute("autocapitalize", "sentences");
    node.setAttribute("autocomplete", "on");
    node.setAttribute("spellcheck", "true");
  }
}

function tabletSuggestOptions(mobile: boolean): monaco.editor.IStandaloneEditorConstructionOptions {
  if (!mobile) {
    return {
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: "off",
      acceptSuggestionOnEnter: "off",
      tabCompletion: "off",
    };
  }
  return {
    // Completions from words already in solution.py — the practical stand-in
    // for autocorrect when typing on a tablet keyboard.
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    wordBasedSuggestions: "currentDocument",
    acceptSuggestionOnEnter: "on",
    tabCompletion: "on",
    suggest: {
      showWords: true,
      preview: true,
      selectionMode: "always",
    },
  };
}

export interface MonacoBlockProps {
  value: string;
  language: string;
  themeId?: string;
  /** Board zoom — Monaco font scales with this so code tracks statement text. */
  zoom?: number;
  /** User-chosen S/M/L — base CSS px, multiplied by zoom. */
  fontSizePref?: CodeFontSize;
  height?: string;
  onChange: (value: string) => void;
  onReady: () => void;
}

export default function MonacoBlock({
  value,
  language,
  themeId = "blue",
  zoom = 1,
  fontSizePref = "M",
  height = "min(42vh, 360px)",
  onChange,
  onReady,
}: MonacoBlockProps) {
  const mobile = useIsMobile();
  const monacoTheme = useMemo(() => ensureMonacoTheme(themeId), [themeId]);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const fontSize = codeFontPx(fontSizePref, zoom);

  useEffect(() => {
    ensureMonacoTheme(themeId);
    monaco.editor.setTheme(monacoThemeName(themeId));
  }, [themeId]);

  // Remount / problem switch can leave Monaco on vs-dark while chrome is light.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      ensureMonacoTheme(themeId);
      monaco.editor.setTheme(monacoThemeName(themeId));
    });
    return () => cancelAnimationFrame(id);
  }, [themeId, value]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize,
      padding: { top: PAD_TOP },
      scrollbar: {
        verticalScrollbarSize: SCROLLBAR,
        horizontalScrollbarSize: SCROLLBAR,
      },
    });
  }, [fontSize]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions(tabletSuggestOptions(mobile));
    if (mobile) enableTabletKeyboardHelpers(editor);
  }, [mobile]);

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
          padding: { top: PAD_TOP },
          scrollbar: {
            verticalScrollbarSize: SCROLLBAR,
            horizontalScrollbarSize: SCROLLBAR,
            arrowSize: 0,
            useShadows: false,
            verticalHasArrows: false,
            horizontalHasArrows: false,
          },
          ...tabletSuggestOptions(mobile),
        });
        if (mobile) enableTabletKeyboardHelpers(editor);
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
        padding: { top: PAD_TOP },
        folding: true,
        // Chromium EditContext focuses a div Excalidraw does not treat as
        // writable, so board shortcuts (H, ?, tools…) fire while coding.
        editContext: false,
        scrollbar: {
          verticalScrollbarSize: SCROLLBAR,
          horizontalScrollbarSize: SCROLLBAR,
          arrowSize: 0,
          useShadows: false,
          verticalHasArrows: false,
          horizontalHasArrows: false,
        },
        ...tabletSuggestOptions(false),
        automaticLayout: true,
      }}
    />
  );
}
