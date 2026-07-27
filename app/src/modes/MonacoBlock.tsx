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

// The package's exports map rewrites `./*` to `./esm/vs/*.js`, so this
// resolves to esm/vs/editor/editor.worker.js — spelling out the esm path here
// would double the prefix.
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";

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

export interface MonacoBlockProps {
  value: string;
  language: string;
  dark?: boolean;
  height?: string;
  onChange: (value: string) => void;
  onReady: () => void;
}

export default function MonacoBlock({
  value,
  language,
  dark = false,
  height = "min(42vh, 360px)",
  onChange,
  onReady,
}: MonacoBlockProps) {
  return (
    <Editor
      height={height}
      language={language}
      theme={dark ? "vs-dark" : "vs"}
      value={value}
      onMount={onReady}
      onChange={(next) => onChange(next ?? "")}
      options={{
        minimap: { enabled: false },
        lineNumbers: "on",
        fontSize: 13,
        fontFamily: "Consolas, 'Cascadia Code', 'Courier New', monospace",
        scrollBeyondLastLine: false,
        wordWrap: "on",
        tabSize: 4,
        renderLineHighlight: "line",
        overviewRulerLanes: 0,
        padding: { top: 8 },
        // A stylus can't easily dismiss an autocomplete popup.
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        automaticLayout: true,
      }}
    />
  );
}
