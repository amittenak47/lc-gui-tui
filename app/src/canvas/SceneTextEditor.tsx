/** In-place text editing uses the same font and geometry as the scene painter. */
import { useLayoutEffect, useRef, useState } from "react";
import type { ViewportTransform } from "./rasterInk";
import { layoutSceneText, sceneTextFont } from "./sceneTextLayout";
import { TextFontSizeControl } from "./TextFontSizeControl";
import { holdSceneTextViewport } from "../util/safeArea";

export interface SceneTextEdit {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  fontFamily?: number;
  lineHeight?: number;
  autoResize?: boolean;
  angle?: number;
  color: string;
  created: boolean;
}

export interface SceneTextEditorProps {
  edit: SceneTextEdit;
  getViewport: () => ViewportTransform | null;
  onFontSize: (size: number) => void;
  onCommit: (draft: SceneTextEdit) => void;
  onCancel: () => void;
}

export function SceneTextEditor({ edit, getViewport, onFontSize, onCommit, onCancel }: SceneTextEditorProps) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const doneRef = useRef(false);
  const [text, setText] = useState(edit.text);
  const [boxWidth, setBoxWidth] = useState(edit.width);
  const [autoResize, setAutoResize] = useState(edit.autoResize !== false);
  const dragRef = useRef<{ x: number; y: number; width: number; autoResize: boolean } | null>(null);
  const [view, setView] = useState(getViewport);
  const zoom = view?.zoom ?? 1;
  const layout = layoutSceneText({ ...edit, text, width: boxWidth, autoResize });
  const width = Math.max(48 / zoom, autoResize ? Math.max(edit.width, layout.width + 2) : layout.width);
  const height = Math.max(edit.fontSize * layout.lineHeight, layout.height);
  const left = (edit.x + (view?.scrollX ?? 0)) * zoom;
  const top = (edit.y + (view?.scrollY ?? 0)) * zoom;

  useLayoutEffect(() => {
    const releaseViewport = holdSceneTextViewport();
    areaRef.current?.focus({ preventScroll: true });
    const len = areaRef.current?.value.length ?? 0;
    areaRef.current?.setSelectionRange(len, len);
    // Soft keyboard and camera changes can occur without a Board render.
    let frame = 0;
    const follow = () => {
      const next = getViewport();
      setView((old) => old?.zoom === next?.zoom && old?.scrollX === next?.scrollX &&
        old?.scrollY === next?.scrollY && old?.width === next?.width && old?.height === next?.height ? old : next);
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => { cancelAnimationFrame(frame); releaseViewport(); };
  }, [getViewport]);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit({ ...edit, text, width: layout.width, height: layout.height, autoResize });
    else onCancel();
  };

  if (!view) return null;
  const controlsTop = top >= 64 ? top - 60 : top + height * zoom + 12;
  return (
    <div className="lc-scene-text-edit" onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); finish(false); }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finish(true); }
      }}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        finish(true);
      }}>
      <div className="lc-scene-text-controls" role="toolbar" aria-label="Text editing"
        style={{ left: Math.max(8, Math.min(view.width - 236, left)), top: Math.max(4, controlsTop) }}>
        <TextFontSizeControl value={edit.fontSize} onChange={onFontSize} label="Text font size" />
        <button type="button" aria-label="Finish editing text" title="Done (Ctrl+Enter)"
          onPointerDown={(event) => event.preventDefault()} onClick={() => finish(true)}>Done</button>
      </div>
      <div className="lc-scene-text-frame" style={{ left, top, width: width * zoom, height: height * zoom,
        transform: edit.angle ? `rotate(${edit.angle}rad)` : undefined }}>
        <textarea ref={areaRef} className="lc-scene-text-editor" value={text} aria-label="Text box"
          spellCheck={false} wrap={autoResize ? "off" : "soft"}
          style={{ width: "100%", height: "100%", fontSize: `${edit.fontSize * zoom}px`,
            lineHeight: layout.lineHeight, color: edit.color, fontFamily: sceneTextFont(edit.fontFamily) }}
          onChange={(event) => setText(event.currentTarget.value)} />
        <button type="button" className="lc-scene-text-width" aria-label="Resize text width"
          title="Drag to change wrap width" onPointerDown={(event) => {
            event.preventDefault();
            dragRef.current = { x: event.clientX, y: event.clientY, width, autoResize };
            event.currentTarget.setPointerCapture(event.pointerId);
          }} onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag) return;
            const angle = edit.angle ?? 0;
            const delta = ((event.clientX - drag.x) * Math.cos(angle) + (event.clientY - drag.y) * Math.sin(angle)) / zoom;
            setBoxWidth(Math.max(edit.fontSize * 2, drag.width + delta));
            setAutoResize(false);
          }} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => {
            if (dragRef.current) { setBoxWidth(dragRef.current.width); setAutoResize(dragRef.current.autoResize); }
            dragRef.current = null;
          }} />
      </div>
    </div>
  );
}
