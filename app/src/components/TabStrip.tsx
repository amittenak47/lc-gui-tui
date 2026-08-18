/**
 * The header tab strip — Home plus every open workspace.
 *
 * This replaces the inner `.lc-web-tabs` row that only ever listed web pages.
 * There is one strip now and it lists everything, because the thing a reader
 * wants to get back to is "the notebook" or "that PDF", not "one of the two
 * kinds of thing that happened to have a strip".
 *
 * It draws from tab records, never from a live workspace: only the painted
 * panes are mounted as boards, so every other chip is its record. That is
 * also why the `[indexed]` badge comes in two forms — the focused tab gets
 * the real {@link DocIndexChip}, with its chunk counts and its popover, and
 * the parked ones get the flat word, which is all their record knows.
 */

import { useEffect, useRef, type ReactNode } from "react";

import { HOME_TAB_ID, type TabIndexState, type TabRecord } from "../util/tabs";

export interface TabStripProps {
  tabs: TabRecord[];
  activeId: string;
  /** A workspace is opening; the strip stops taking taps. */
  busy?: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  /** The live index chip for the active document, if it has one. */
  activeIndexChip?: ReactNode;
  /**
   * A workspace is opening, and this cancels it.
   *
   * Home takes the job rather than a Cancel button appearing beside the strip:
   * a chip that arrives for the length of a load shifts every tab along and
   * then shifts them back, and the place you land when you cancel *is* Home.
   */
  onCancelLoad?: () => void;
  /**
   * Drag a chip onto the board to split. Home does not drag.
   *
   * Pointer coords, not HTML5 drag — Android WebView drops that on the floor.
   */
  onTabDrag?: (id: string, x: number, y: number) => void;
  onTabDrop?: (id: string, x: number, y: number) => void;
  onTabDragEnd?: () => void;
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="lc-tab-glyph"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Same shapes as the home cards and the header icons — one vocabulary. */
function TabIcon({ kind }: { kind: TabRecord["kind"] | "cancel" }) {
  switch (kind) {
    case "home":
      return (
        <Glyph>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5.5 9.5V20h13V9.5" />
        </Glyph>
      );
    case "cancel":
      return (
        <Glyph>
          <circle cx="12" cy="12" r="9" />
          <path d="m9 9 6 6M15 9l-6 6" />
        </Glyph>
      );
    case "practice":
      return (
        <Glyph>
          <path d="m9 8-3.5 4L9 16" />
          <path d="m15 8 3.5 4L15 16" />
          <path d="M13.4 5.5 10.6 18.5" />
        </Glyph>
      );
    case "whiteboard":
      return (
        <Glyph>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8" />
          <path d="M8 17h5" />
        </Glyph>
      );
    case "annotate":
      return (
        <Glyph>
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9" />
          <path d="M13 2v6h6V9" />
          <path d="m20.2 11.3-6.6 6.6-2.8.8.8-2.8 6.6-6.6z" />
        </Glyph>
      );
    case "web":
      return (
        <Glyph>
          <circle cx="12" cy="12" r="9.5" />
          <path d="M2.5 12h19" />
          <path d="M12 2.5a14.5 14.5 0 0 1 3.8 9.5 14.5 14.5 0 0 1-3.8 9.5 14.5 14.5 0 0 1-3.8-9.5A14.5 14.5 0 0 1 12 2.5z" />
        </Glyph>
      );
  }
}

/** Only annotate and web tabs are embedded, so only they can say `indexed`. */
function indexStateOf(tab: TabRecord): TabIndexState | null {
  if (tab.kind !== "annotate" && tab.kind !== "web") return null;
  return tab.indexed;
}

export function TabStrip({
  tabs,
  activeId,
  busy = false,
  onFocus,
  onClose,
  activeIndexChip,
  onCancelLoad,
  onTabDrag,
  onTabDrop,
  onTabDragEnd,
}: TabStripProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const skipClickRef = useRef(false);

  // A tab focused from anywhere other than the strip — an icon spawning one,
  // a close landing on its neighbour — can be scrolled out of sight.
  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>('[data-tab-active="true"]');
    if (!active) return;
    const snap = () => active.scrollIntoView({ block: "nearest", inline: "nearest" });
    snap();
    const first = window.requestAnimationFrame(() => {
      snap();
      window.requestAnimationFrame(snap);
    });
    return () => window.cancelAnimationFrame(first);
  }, [activeId, tabs.length, busy, activeIndexChip]);

  return (
    <div className="lc-tab-strip" role="tablist" aria-label="Open workspaces" ref={stripRef}>
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        const indexState = indexStateOf(tab);
        // Home wears Cancel for the length of a load — same chip, same slot.
        const cancelling = tab.kind === "home" && Boolean(onCancelLoad);
        const label = cancelling ? "Cancel" : tab.title;
        const grouped = Boolean(tab.group);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={selected}
            data-tab-active={selected ? "true" : "false"}
            data-tab-kind={cancelling ? "cancel" : tab.kind}
            data-tab-group={tab.group ?? undefined}
            className={[
              cancelling ? "lc-tab is-cancelling" : selected ? "lc-tab is-active" : "lc-tab",
              grouped ? "is-grouped" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <button
              type="button"
              className="lc-tab-hit"
              disabled={busy && !cancelling}
              title={cancelling ? "Cancel loading" : tab.title}
              aria-label={label}
              onClick={() => {
                if (skipClickRef.current) {
                  skipClickRef.current = false;
                  return;
                }
                cancelling ? onCancelLoad?.() : onFocus(tab.id);
              }}
              onPointerDown={(event) => {
                if (cancelling || tab.id === HOME_TAB_ID || busy) return;
                if (event.button !== 0) return;
                dragRef.current = { id: tab.id, x: event.clientX, y: event.clientY, moved: false };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag || drag.id !== tab.id) return;
                const dx = event.clientX - drag.x;
                const dy = event.clientY - drag.y;
                if (!drag.moved && dx * dx + dy * dy < 100) return;
                drag.moved = true;
                onTabDrag?.(tab.id, event.clientX, event.clientY);
              }}
              onPointerUp={(event) => {
                const drag = dragRef.current;
                if (!drag || drag.id !== tab.id) return;
                if (drag.moved) {
                  skipClickRef.current = true;
                  onTabDrop?.(tab.id, event.clientX, event.clientY);
                }
                dragRef.current = null;
                onTabDragEnd?.();
              }}
              onPointerCancel={() => {
                dragRef.current = null;
                onTabDragEnd?.();
              }}
            >
              <TabIcon kind={cancelling ? "cancel" : tab.kind} />
              <span className="lc-tab-title">{label}</span>
              {tab.dirty ? (
                <span className="lc-tab-dot" aria-label="Unsaved changes" title="Unsaved changes" />
              ) : null}
            </button>
            {selected && activeIndexChip ? (
              activeIndexChip
            ) : indexState === "indexed" ? (
              <span className="lc-doc-index-chip">indexed</span>
            ) : indexState === "indexing" ? (
              <span className="lc-doc-index-chip">indexing…</span>
            ) : null}
            {tab.id === HOME_TAB_ID ? null : (
              <button
                type="button"
                className="lc-tab-close"
                aria-label={`Close ${tab.title}`}
                onClick={() => onClose(tab.id)}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
