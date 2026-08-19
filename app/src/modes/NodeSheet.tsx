/**
 * What one node is, and where it goes.
 *
 * Deliberately the same shell as {@link ../canvas/InkPresetEditor}: it morphs
 * out of the thing you tapped, it has a Back, a swatch, an editable name and a
 * meta line, and its body is a MorphBar. A reader who has held a nib to edit it
 * has already learned this panel, and a graph node is the same kind of object,
 * something on the canvas you want to inspect and act on without leaving.
 *
 * What it does not borrow is the sliders. A node has no stroke width. The
 * buttons here are its own, because opening a workspace and saving a preset are
 * not the same gesture and should not look like it.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { MorphBar } from "../components/MorphBar";
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
  /** Rows for the What panel. */
  spec: ReadonlyArray<[string, string]>;
  /** Accent for the swatch, matching the node's ring on the canvas. */
  tint: string;
  canOpenInNewTab: boolean;
  onOpen: () => void;
  onOpenInNewTab: () => void;
  /** Walk to a neighbour without leaving the atlas. */
  onHop: (node: NodeRef) => void;
  onUnlink: (edgeId: string) => void;
  /** Rename the set or notebook this node stands for. */
  onRename?: (title: string) => void;
  onClose: () => void;
}

type Panel = "what" | "links";

const KIND_LABEL: Record<NodeType, string> = {
  annotate: "NOTE",
  whiteboard: "WHITEBOARD",
  practice: "PRACTICE",
  web: "WEB",
  thread: "THREAD",
};

export function NodeSheet({
  node,
  from,
  neighbours,
  spec,
  tint,
  canOpenInNewTab,
  onOpen,
  onOpenInNewTab,
  onHop,
  onUnlink,
  onRename,
  onClose,
}: NodeSheetProps) {
  const [panel, setPanel] = useState<Panel>("what");
  const [title, setTitle] = useState(node.title ?? node.id);
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const missing = isUnresolved(node);

  // Reset when the sheet is pointed at a different node without unmounting,
  // which is what hopping does.
  useEffect(() => {
    setTitle(node.title ?? node.id);
    setPanel("what");
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
          <button type="button" className="lc-preset-sheet-back" onClick={close}>
            Back
          </button>
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

        <nav className="lc-node-sheet-tabs" role="tablist" aria-label="Node panels">
          {(["what", "links"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={panel === id}
              className={panel === id ? "lc-node-sheet-tab is-active" : "lc-node-sheet-tab"}
              onClick={() => setPanel(id)}
            >
              {id === "what" ? "What" : `Links (${neighbours.length})`}
            </button>
          ))}
        </nav>

        <div className="lc-preset-sheet-body lc-scroll-pane">
          <MorphBar active={panel} axis="height" className="lc-preset-sheet-morph">
            <div data-morph-id="what">
              <section className="lc-node-sheet-panel">
                {missing && (
                  <p className="lc-settings-hint">
                    A link points here, but nothing by that name exists yet. Make a note called
                    "{node.title ?? node.id}" and this fills itself in.
                  </p>
                )}
                <dl className="lc-node-sheet-spec">
                  {spec.map(([label, value]) => (
                    <div key={label} className="lc-node-sheet-spec-row">
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
            <div data-morph-id="links">
              <section className="lc-node-sheet-panel">
                {neighbours.length === 0 ? (
                  <p className="lc-settings-hint">
                    Nothing links here yet. Type <code>[[brackets]]</code> in a note you own, or
                    use Link while annotating.
                  </p>
                ) : (
                  <ul className="lc-node-sheet-links">
                    {neighbours.map((row) => (
                      <li key={row.edgeId}>
                        <button
                          type="button"
                          className="lc-node-sheet-link"
                          onClick={() => onHop(row.node)}
                        >
                          <strong>{row.node.title ?? row.node.id}</strong>
                          <span className="lc-muted">{row.kindLabel}</span>
                        </button>
                        <button
                          type="button"
                          className="lc-node-sheet-unlink"
                          aria-label={`Unlink ${row.node.title ?? row.node.id}`}
                          title="Remove this link. The workspace it points at is untouched."
                          onClick={() => onUnlink(row.edgeId)}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            width="14"
                            height="14"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                            aria-hidden
                          >
                            <path d="M6 6l12 12M18 6 6 18" />
                          </svg>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </MorphBar>
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
  const width = Math.min(400, Math.max(280, viewW - 24));
  const pad = 12;
  const left = Math.max(pad, Math.min(from.left + from.width / 2 - width / 2, viewW - width - pad));
  const below = from.top + from.height + 14;
  const top = below + 320 > viewH - pad ? Math.max(pad, from.top - 12 - 280) : below;
  return { left, top, width };
}
