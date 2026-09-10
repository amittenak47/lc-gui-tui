/**
 * In-place editor for scene text. Excalidraw's wysiwyg is gone.
 */

import { useEffect, useRef } from "react";

import { FONT_CODE } from "../templates/skeleton";
import type { ViewportTransform } from "./rasterInk";

export interface SceneTextEdit {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  fontFamily?: number;
  color: string;
  /** True when this box was just placed — empty cancel deletes it. */
  created: boolean;
}

export interface SceneTextEditorProps {
  edit: SceneTextEdit;
  getViewport: () => ViewportTransform | null;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

export function SceneTextEditor({ edit, getViewport, onCommit, onCancel }: SceneTextEditorProps) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const doneRef = useRef(false);
  const view = getViewport();
  const zoom = view?.zoom ?? 1;
  const left = view ? (edit.x + view.scrollX) * zoom : 0;
  const top = view ? (edit.y + view.scrollY) * zoom : 0;
  const width = Math.max(48, edit.width * zoom);
  const height = Math.max(24, edit.height * zoom);
  const fontPx = Math.max(12, edit.fontSize * zoom);
  const mono = edit.fontFamily === FONT_CODE;

  useEffect(() => {
    doneRef.current = false;
    const node = areaRef.current;
    if (!node) return;
    node.focus();
    const len = node.value.length;
    node.setSelectionRange(len, len);
  }, [edit.id]);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit(areaRef.current?.value ?? "");
    else onCancel();
  };

  if (!view) return null;

  return (
    <textarea
      ref={areaRef}
      className="lc-scene-text-editor"
      defaultValue={edit.text}
      aria-label="Text box"
      style={{
        left,
        top,
        width,
        height,
        fontSize: `${fontPx}px`,
        lineHeight: 1.25,
        color: edit.color,
        fontFamily: mono
          ? "ui-monospace, Cascadia Code, Consolas, monospace"
          : "Helvetica, Arial, sans-serif",
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          finish(true);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}
