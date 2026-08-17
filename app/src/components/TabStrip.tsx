/**
 * The header tab strip — Home plus every open workspace.
 *
 * This replaces the inner `.lc-web-tabs` row that only ever listed web pages.
 * There is one strip now and it lists everything, because the thing a reader
 * wants to get back to is "the notebook" or "that PDF", not "one of the two
 * kinds of thing that happened to have a strip".
 *
 * It draws from tab records, never from a live workspace: only one board is
 * mounted, so every tab but the active one has nothing behind it but its
 * record. That is also why the `[indexed]` badge comes in two forms — the
 * active tab gets the real {@link DocIndexChip}, with its chunk counts and its
 * popover, and the parked ones get the flat word, which is all their record
 * knows.
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
function TabIcon({ kind }: { kind: TabRecord["kind"] }) {
  switch (kind) {
    case "home":
      return (
        <Glyph>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5.5 9.5V20h13V9.5" />
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
}: TabStripProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  // A tab focused from anywhere other than the strip — an icon spawning one,
  // a close landing on its neighbour — can be scrolled out of sight.
  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>('[data-tab-active="true"]');
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  return (
    <div className="lc-tab-strip" role="tablist" aria-label="Open workspaces" ref={stripRef}>
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        const indexState = indexStateOf(tab);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={selected}
            data-tab-active={selected ? "true" : "false"}
            data-tab-kind={tab.kind}
            className={selected ? "lc-tab is-active" : "lc-tab"}
          >
            <button
              type="button"
              className="lc-tab-hit"
              disabled={busy}
              title={tab.title}
              aria-label={tab.title}
              onClick={() => onFocus(tab.id)}
            >
              <TabIcon kind={tab.kind} />
              <span className="lc-tab-title">{tab.title}</span>
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
                disabled={busy}
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
