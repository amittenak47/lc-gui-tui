import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AnimatedDisclosure } from "../components/AnimatedDisclosure";
import { AgentRichText } from "../modes/AgentRichText";
import type { AgentChatMessage } from "../modes/AgentSidePanel";
import {
  peekPdfFilmCurrent,
  peekPdfIntersectingPages,
  peekPdfReadingFrames,
  subscribePdfFilmCurrent,
  subscribePdfViewPages,
} from "../modes/pdfFilm";
import { loadInkHandedness, type InkHandedness } from "../util/inkHandedness";
import { loadUiHandedness } from "../util/uiHandedness";
import { DrawingPreview } from "./DrawingPreview";
import {
  drawingDockSide,
  drawingSlideOffX,
  drawingStacksWithInk,
  type ChromeHand,
} from "./drawingDock";
import {
  bindDrawingPage,
  drawingIsOnScreen,
  resolveDrawingPage,
  type DrawingPageMark,
} from "./drawingPage";
import { isDrawingVisible } from "./drawingState";
import { Timeline } from "./Timeline";
import { drawingHeading, formatVizProse } from "./vizProse";

const FOLD_MS = 180;
const SLIDE_MS = 240;
const EASE = [0.22, 1, 0.36, 1] as const;

interface DocumentDrawingPanelProps {
  messages: AgentChatMessage[];
  onHide: (messageId: string, expanded: boolean) => void;
  onFrame: (programId: string, frame: number) => void;
  filmScope?: string;
  footnotes?: readonly DrawingPageMark[];
  uiHand?: ChromeHand;
  inkHand?: ChromeHand;
  currentPage?: number;
  intersectingPages?: readonly number[];
  pageCount?: number;
}

export function DocumentDrawingPanel(props: DocumentDrawingPanelProps) {
  const visible = props.messages.some((message) => isDrawingVisible(message.drawing));
  return (
    <div className="lc-document-drawing-host" aria-hidden={!visible || undefined}>
      <AnimatePresence>
        {visible && <DrawingPanelContent key="drawing" {...props} />}
      </AnimatePresence>
    </div>
  );
}

function ExpandGlyph({ enlarged }: { enlarged: boolean }) {
  return (
    <svg className="lc-agent-pane-expand-icon" viewBox="0 0 16 16" aria-hidden>
      {enlarged ? (
        <path
          d="M6 3.5H3.5V6M10 12.5h2.5V10M3.5 3.5l4 4M12.5 12.5l-4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M12.5 6.5V3.5H9.5M3.5 9.5v3h3M12.5 3.5l-4 4M3.5 12.5l4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function useDocumentFocus(
  filmScope: string | undefined,
  currentPage: number | undefined,
  intersectingPages: readonly number[] | undefined,
): { current: number; intersecting: readonly number[] } {
  const [liveCurrent, setLiveCurrent] = useState(() =>
    currentPage ?? (filmScope ? peekPdfFilmCurrent(filmScope) : 0),
  );
  const [liveIntersecting, setLiveIntersecting] = useState<readonly number[]>(() =>
    intersectingPages
      ? [...intersectingPages]
      : filmScope
        ? [...peekPdfIntersectingPages(filmScope)]
        : [],
  );
  useEffect(() => {
    if (filmScope) return;
    if (currentPage != null) setLiveCurrent(currentPage);
  }, [filmScope, currentPage]);
  useEffect(() => {
    if (filmScope) return;
    if (intersectingPages) setLiveIntersecting([...intersectingPages]);
  }, [filmScope, intersectingPages]);
  useEffect(() => {
    if (!filmScope) return;
    return subscribePdfFilmCurrent(filmScope, setLiveCurrent);
  }, [filmScope]);
  useEffect(() => {
    if (!filmScope) return;
    return subscribePdfViewPages(filmScope, () => {
      setLiveIntersecting([...peekPdfIntersectingPages(filmScope)]);
    });
  }, [filmScope]);
  return {
    current: filmScope ? liveCurrent : (currentPage ?? liveCurrent),
    intersecting: filmScope ? liveIntersecting : (intersectingPages ?? liveIntersecting),
  };
}

function useChromeHands(uiHand?: ChromeHand, inkHand?: ChromeHand): { ui: ChromeHand; ink: ChromeHand } {
  const [ui, setUi] = useState<ChromeHand>(() => uiHand ?? loadUiHandedness());
  const [ink, setInk] = useState<ChromeHand>(() => inkHand ?? loadInkHandedness());
  useEffect(() => {
    if (uiHand) {
      setUi(uiHand);
      return;
    }
    const refresh = (event: Event) => {
      const next = (event as CustomEvent<ChromeHand>).detail;
      setUi(next === "left" || next === "right" ? next : loadUiHandedness());
    };
    window.addEventListener("lc-ui-handedness", refresh);
    return () => window.removeEventListener("lc-ui-handedness", refresh);
  }, [uiHand]);
  useEffect(() => {
    if (inkHand) {
      setInk(inkHand);
      return;
    }
    const refresh = (event: Event) => {
      const next = (event as CustomEvent<InkHandedness>).detail;
      setInk(next === "left" || next === "right" ? next : loadInkHandedness());
    };
    window.addEventListener("lc-ink-handedness", refresh);
    return () => window.removeEventListener("lc-ink-handedness", refresh);
  }, [inkHand]);
  return { ui, ink };
}

function DrawingPanelContent({
  messages,
  onHide,
  onFrame,
  filmScope,
  footnotes = [],
  uiHand,
  inkHand,
  currentPage,
  intersectingPages,
  pageCount = 0,
}: DocumentDrawingPanelProps) {
  const reduced = useReducedMotion();
  const { current, intersecting } = useDocumentFocus(filmScope, currentPage, intersectingPages);
  const { ui, ink } = useChromeHands(uiHand, inkHand);
  const dock = drawingDockSide(ui);
  const stacked = drawingStacksWithInk(ui, ink);
  const slideX = drawingSlideOffX(dock);
  const paged =
    pageCount >= 1 ||
    current > 1 ||
    intersecting.length > 0 ||
    Boolean(filmScope && peekPdfReadingFrames(filmScope).length > 0);
  const boundPages = useRef(new Map<string, number>());
  const visible = messages.filter((message) => isDrawingVisible(message.drawing));
  const pageOf = (message: AgentChatMessage) => {
    const resolved = resolveDrawingPage(
      message.drawing?.page,
      message.artifactFootnoteIds,
      footnotes,
    );
    const bound = boundPages.current.get(message.id);
    const viewKnown = intersecting.length > 0 || current > 1;
    const page = bindDrawingPage(resolved, bound, current, paged, viewKnown);
    if (page != null && bound !== page && resolved == null) boundPages.current.set(message.id, page);
    return page;
  };
  const onScreen = visible.filter((message) =>
    drawingIsOnScreen(pageOf(message), current, intersecting, paged),
  );
  const lastOnScreen = useRef<AgentChatMessage[]>(onScreen);
  if (onScreen.length > 0) lastOnScreen.current = onScreen;
  const shown = onScreen.length > 0 ? onScreen : lastOnScreen.current;
  const onPage = onScreen.length > 0;
  const [selected, setSelected] = useState<string | null>(null);
  const [folded, setFolded] = useState(!onPage);
  const [parked, setParked] = useState(!onPage);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (onPage) {
      setParked(false);
      setMaximized(false);
      if (reduced) {
        setFolded(false);
        return;
      }
      const t = window.setTimeout(() => setFolded(false), SLIDE_MS);
      return () => clearTimeout(t);
    }
    setMaximized(false);
    setFolded(true);
    if (reduced) {
      setParked(true);
      return;
    }
    const t = window.setTimeout(() => setParked(true), FOLD_MS);
    return () => clearTimeout(t);
  }, [onPage, reduced]);
  const message = shown.find((entry) => entry.id === selected) ?? shown.at(-1);
  const drawing = message?.drawing;
  if (!drawing || !message || shown.length === 0) return null;
  const enlargeLabel = maximized ? "Shrink drawing" : "Enlarge drawing";
  const compact = folded;
  const className = [
    "lc-document-drawing-panel",
    dock === "left" ? "is-dock-left" : "is-dock-right",
    stacked ? "is-stacked" : "",
    maximized && !parked && !compact ? "is-maximized" : "",
    parked ? "is-parked" : "",
    compact ? "is-folded" : "",
  ].filter(Boolean).join(" ");
  return <motion.section
    className={className}
    aria-label="Drawing on this document"
    aria-hidden={parked || undefined}
    style={{
      originX: dock === "right" ? 1 : 0,
      originY: 0,
      ["--lc-drawing-slide-x" as string]: slideX,
    }}
    initial={reduced ? false : { opacity: 0, x: slideX }}
    animate={parked ? { opacity: reduced ? 0 : 1, x: slideX } : { opacity: 1, x: 0 }}
    exit={reduced ? { opacity: 0 } : { opacity: 0, x: slideX }}
    transition={{ duration: reduced ? 0 : SLIDE_MS / 1000, ease: EASE }}>
    <header>
      <button type="button" className="lc-drawing-fold" aria-expanded={!compact}
        onClick={() => {
          if (parked) return;
          setFolded((value) => {
            const next = !value;
            if (next) setMaximized(false);
            return next;
          });
        }}>
        {compact ? "▸" : "▾"} Drawing{shown.length > 1 ? ` · ${shown.length}` : ""}
      </button>
      {!compact ? (
        <button
          type="button"
          className={`lc-flag lc-agent-pane-expand${maximized && !parked ? " is-expanded" : ""}`}
          aria-pressed={maximized && !parked}
          aria-label={enlargeLabel}
          title={enlargeLabel}
          disabled={parked}
          onClick={() => setMaximized((value) => !value)}
        >
          <ExpandGlyph enlarged={maximized && !parked} />
        </button>
      ) : null}
      <button type="button" className="lc-drawing-hide" aria-label="Hide drawing"
        disabled={parked}
        onClick={() => onHide(message.id, false)}>×</button>
    </header>
    <AnimatedDisclosure open={!compact}>
      {shown.length > 1 ? (
        <div className="lc-document-drawing-tabs" role="tablist" aria-label="Drawings on this page">
          {shown.map((entry) => {
            const title = drawingHeading(entry.drawing!.program, entry.drawing!.frameIndex ?? 0);
            const active = entry.id === message.id;
            return <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`lc-document-drawing-tab${active ? " is-active" : ""}`}
              onClick={() => { setSelected(entry.id); setMaximized(false); }}
            >{title}</button>;
          })}
        </div>
      ) : <AgentRichText
        text={formatVizProse(drawingHeading(drawing.program, drawing.frameIndex ?? 0))}
        className="lc-document-drawing-title"
      />}
      <DrawingPreview
        program={drawing.program}
        frameIndex={drawing.frameIndex ?? 0}
        title={drawingHeading(drawing.program, drawing.frameIndex ?? 0)}
      />
      <Timeline key={drawing.program.id} program={drawing.program} initialFrame={drawing.frameIndex ?? 0}
        onFrame={(frame) => onFrame(drawing.program.id, frame)} />
    </AnimatedDisclosure>
  </motion.section>;
}
