/**
 * The links on one node.
 *
 * Same shell as the catalog: a compact card, a name, and a short list. It
 * still grows out of the node you tapped. Opening a workspace stays a tap.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { isUnresolved, type NodeRef, type NodeType } from "../util/noteLinks";

export interface NodeSheetNeighbour {
  edgeId: string;
  node: NodeRef;
  kindLabel: string;
}

export interface NodeSheetProps {
  node: NodeRef;
  /** The node's on-screen box, so the panel grows out of it. */
  from: { left: number; top: number; width: number; height: number };
  neighbours: readonly NodeSheetNeighbour[];
  /** Accent for the swatch, matching the node's ring on the canvas. */
  tint: string;
  canOpenInNewTab: boolean;
  onOpen: () => void;
  onOpenInNewTab: () => void;
  /** Walk to a neighbour without leaving the atlas. */
  onHop: (node: NodeRef) => void;
  /** Rename the set or notebook this node stands for. */
  onRename?: (title: string) => void;
  onClose: () => void;
}

const KIND_LABEL: Record<NodeType, string> = {
  annotate: "NOTE",
  whiteboard: "WHITEBOARD",
  practice: "PRACTICE",
  web: "WEB",
  thread: "THREAD",
};

const KIND_TINT: Record<NodeType, string> = {
  annotate: "var(--lc-mode-annotate)",
  whiteboard: "var(--lc-mode-whiteboard)",
  practice: "var(--lc-mode-practice)",
  web: "var(--lc-mode-browse)",
  thread: "var(--lc-mode-explore)",
};

export function NodeSheet({
  node,
  from,
  neighbours,
  tint,
  canOpenInNewTab,
  onOpen,
  onOpenInNewTab,
  onHop,
  onRename,
  onClose,
}: NodeSheetProps) {
  const [title, setTitle] = useState(node.title ?? node.id);
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const missing = isUnresolved(node);

  // Reset when the sheet is pointed at a different node without unmounting,
  // which is what hopping does.
  useEffect(() => {
    setTitle(node.title ?? node.id);
  }, [node]);

  const close = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => closeRef.current(), 200);
  };

  const place = sheetPlace(from);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  const commitRename = () => {
    const next = title.trim();
    if (!next || next === (node.title ?? node.id)) return;
    onRename?.(next);
  };

  return createPortal(
    <div className="lc-preset-sheet-layer" onPointerDown={close}>
      <div
        className={`lc-preset-sheet lc-node-sheet ${closing ? "is-closing" : "is-open"}`}
        style={{
          left: place.left,
          top: place.top,
          width: place.width,
          ["--lc-morph-x" as string]: `${from.left + from.width / 2}px`,
          ["--lc-morph-y" as string]: `${from.top + from.height / 2}px`,
        }}
        role="dialog"
        aria-label={`${node.title ?? node.id}, ${KIND_LABEL[node.type].toLowerCase()}`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="lc-preset-sheet-head">
          <span className="lc-preset-sheet-swatch" style={{ background: tint }} />
          <input
            className="lc-preset-sheet-name"
            value={title}
            readOnly={!onRename || missing}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            aria-label="Display name"
          />
          <span className="lc-preset-sheet-meta">
            {KIND_LABEL[node.type]}
            {missing ? " · MISSING" : ""} · {neighbours.length}{" "}
            {neighbours.length === 1 ? "LINK" : "LINKS"}
          </span>
        </header>

        <div className="lc-preset-sheet-body lc-scroll-pane">
          <section className="lc-node-sheet-panel" aria-label="Links">
            {missing && (
              <p className="lc-settings-hint">
                A link points here, but nothing by that name exists yet.
              </p>
            )}
            {neighbours.length === 0 ? (
              <p className="lc-settings-hint">Nothing links here yet.</p>
            ) : (
              <ul className="lc-node-sheet-links">
                {neighbours.map((row) => (
                  <li key={row.edgeId}>
                    <button
                      type="button"
                      className="lc-node-sheet-link"
                      onClick={() => onHop(row.node)}
                    >
                      <span
                        className="lc-explore-chip-dot"
                        style={{ background: KIND_TINT[row.node.type] }}
                      />
                      <strong>{row.node.title ?? row.node.id}</strong>
                      <span className="lc-muted">{row.kindLabel}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {!missing && (
          <footer className="lc-node-sheet-foot">
            <button type="button" className="lc-node-btn is-primary" onClick={onOpen}>
              Open
            </button>
            <button
              type="button"
              className="lc-node-btn"
              disabled={!canOpenInNewTab}
              title={canOpenInNewTab ? undefined : "Practice is one tab"}
              onClick={onOpenInNewTab}
            >
              Open in new tab
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Park the sheet near the node, clamped to the viewport. */
function sheetPlace(from: { left: number; top: number; width: number; height: number }): {
  left: number;
  top: number;
  width: number;
} {
  const viewW = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewH = typeof window === "undefined" ? 768 : window.innerHeight;
  const width = Math.min(320, Math.max(240, viewW - 24));
  const pad = 12;
  const left = Math.max(pad, Math.min(from.left + from.width / 2 - width / 2, viewW - width - pad));
  const below = from.top + from.height + 14;
  const top = below + 320 > viewH - pad ? Math.max(pad, from.top - 12 - 280) : below;
  return { left, top, width };
}
