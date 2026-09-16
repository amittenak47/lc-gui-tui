import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AnimatedDisclosure } from "../components/AnimatedDisclosure";
import { convertToExcalidrawElements } from "../canvas/convertSkeletons";
import { getCommonBounds } from "../canvas/boardScene";
import { paintSceneToExport } from "../canvas/paintScene";
import type { AgentChatMessage } from "../modes/AgentSidePanel";
import { isDrawingVisible } from "./drawingState";
import { renderViz } from "./render";
import { Timeline } from "./Timeline";

/** A document's chat drawings stay in a bounded viewer over the page. */
interface DocumentDrawingPanelProps {
  messages: AgentChatMessage[];
  onHide: (messageId: string, expanded: boolean) => void;
  onFrame: (programId: string, frame: number) => void;
}

export function DocumentDrawingPanel(props: DocumentDrawingPanelProps) {
  return <AnimatePresence>
    {props.messages.some(message => isDrawingVisible(message.drawing)) &&
      <DrawingPanelContent key="drawing" {...props} />}
  </AnimatePresence>;
}

function DrawingPanelContent({ messages, onHide, onFrame }: DocumentDrawingPanelProps) {
  const reduced = useReducedMotion();
  const visible = messages.filter((message) => isDrawingVisible(message.drawing));
  const [selected, setSelected] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  const message = visible.find((entry) => entry.id === selected) ?? visible.at(-1);
  const drawing = message?.drawing;
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useMemo(() => drawing ? convertToExcalidrawElements(
    renderViz(drawing.program, drawing.frameIndex ?? 0, { x: 0, y: 0 }),
    { regenerateIds: false }) : [], [drawing?.program, drawing?.frameIndex]);
  useEffect(() => {
    const node = canvas.current;
    if (!node || !scene.length) return;
    const paint = () => {
      const ctx = node.getContext("2d");
      if (!ctx) return;
      const width = node.clientWidth;
      const height = node.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      node.width = Math.round(width * dpr);
      node.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const [x, y, right, bottom] = getCommonBounds(scene);
      const scale = Math.min((width - 24) / Math.max(1, right - x),
        (height - 24) / Math.max(1, bottom - y), 1.4);
      ctx.translate((width - (right - x) * scale) / 2, (height - (bottom - y) * scale) / 2);
      ctx.scale(scale, scale);
      ctx.translate(-x, -y);
      paintSceneToExport(ctx, scene, { minX: 0, minY: 0, padding: 0, exportScale: 1 });
    };
    paint();
    const resize = new ResizeObserver(paint);
    resize.observe(node);
    return () => resize.disconnect();
  }, [scene, compact]);
  if (!drawing || !message) return null;
  return <motion.section className="lc-document-drawing-panel" aria-label="Drawing on this document"
    initial={reduced ? false : { opacity: 0, scale: 0.45 }}
    animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: reduced ? 1 : 0.45 }}
    style={{ originX: 1, originY: 0 }}
    transition={{ duration: reduced ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}>
    <header>
      <button type="button" className="lc-drawing-fold" aria-expanded={!compact}
        onClick={() => setCompact((value) => !value)}>{compact ? "▸" : "▾"} Drawing</button>
      <button type="button" className="lc-drawing-hide" aria-label="Hide drawing"
        onClick={() => onHide(message.id, false)}>×</button>
    </header>
    <AnimatedDisclosure open={!compact}>
      {visible.length > 1 ? <select aria-label="Visible drawing" value={message.id}
        onChange={(event) => setSelected(event.target.value)}>
        {visible.map((entry) => <option key={entry.id} value={entry.id}>
          {entry.drawing!.program.title || "Drawing"}</option>)}
      </select> : <div className="lc-document-drawing-title">{drawing.program.title || "Diagram"}</div>}
      <canvas ref={canvas} role="img" aria-label={drawing.program.title || "Agent drawing"} />
      <Timeline key={drawing.program.id} program={drawing.program} initialFrame={drawing.frameIndex ?? 0}
        onFrame={(frame) => onFrame(drawing.program.id, frame)} />
    </AnimatedDisclosure>
  </motion.section>;
}
