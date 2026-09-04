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

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "motion/react";

import { DOUBLE_TAP_MS } from "../util/gesture";
import { tabAllowsRename } from "../util/libraryPadRename";
import {
  HOME_TAB_ID,
  isFootnoteBoardTab,
  type SplitEdge,
  type TabGroup,
  type TabIndexState,
  type TabRecord,
} from "../util/tabs";

/** Press flash on Home-as-Cancel before the load-complete hold starts. */
export const CANCEL_HIT_MS = 160;

export interface TabStripProps {
  tabs: TabRecord[];
  /** Splits, so the strip can draw the pair inside one frame. */
  groups?: TabGroup[];
  activeId: string;
  /** A workspace is opening; the strip stops taking taps. */
  busy?: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  /** The live index chip for the active document, if it has one. */
  activeIndexChip?: ReactNode;
  /**
   * A workspace is opening, and going Home abandons it.
   *
   * Home no longer *becomes* a Cancel button for the length of a load. Renaming
   * the one fixed landmark in the strip mid-load was the problem: the chip you
   * aim at to leave stopped saying Home exactly when you wanted it. Home stays
   * Home; pressing it drops the load on the way, which is what leaving means.
   */
  onCancelLoad?: () => void;
  /**
   * Drag a chip onto another chip to split them side by side. Home does not drag.
   *
   * Pointer coords, not HTML5 drag — Android WebView drops that on the floor.
   */
  onTabDrag?: (id: string, x: number, y: number) => void;
  onTabDrop?: (id: string, x: number, y: number) => void;
  onTabDragEnd?: () => void;
  /**
   * Dropped onto another workspace chip — those two become a vertical split.
   */
  onTabDropOnTab?: (dragId: string, ontoId: string) => void;
  /**
   * Split from the chip's menu, for readers who never find the drag.
   *
   * Joins this tab to the one already on screen, side by side. Horizontal
   * split is not offered — it fights the existing chrome.
   */
  onSplitWithActive?: (id: string, edge: SplitEdge) => void;
  onUnsplit?: (id: string) => void;
  /** Which tabs are currently half of a split, so the menu can say `Unsplit`. */
  groupedIds?: string[];
  /**
   * Double-tap a chip to rename it. Home, Practice, Explore, and footnote
   * boards are not offered — {@link tabAllowsRename}.
   */
  onRename?: (id: string, title: string) => void;
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
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9" />
          <path d="M13 2v6h6V9" />
          <path d="m20.2 11.3-6.6 6.6-2.8.8.8-2.8 6.6-6.6z" />
        </Glyph>
      );
    case "annotate":
      return (
        <Glyph>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8" />
          <path d="M8 17h5" />
        </Glyph>
      );
    case "explore":
      // Same hub-and-satellites as the Home card, at strip weight.
      return (
        <Glyph>
          <circle cx="12" cy="12" r="2.4" />
          <circle cx="5.2" cy="6.8" r="1.4" />
          <circle cx="19" cy="7.6" r="1.4" />
          <circle cx="6.6" cy="18" r="1.4" />
          <path d="M6.4 7.7 10.1 10.7" />
          <path d="M17.8 8.6 14.2 10.9" />
          <path d="M7.7 17 10.4 13.9" />
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

function pointInBox(box: DOMRect, x: number, y: number): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/**
 * How far outside `box` the point is, along whichever axis it left by.
 *
 * Zero while it is still inside. Used to ask "is this clearly out of the pair's
 * row" without demanding that the reader find somewhere else to be.
 */
export function distanceOutside(
  box: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
): number {
  const dx = Math.max(box.left - x, x - box.right, 0);
  const dy = Math.max(box.top - y, y - box.bottom, 0);
  return Math.max(dx, dy);
}

/**
 * How far past the pair's row a chip has to be carried to leave it.
 *
 * Enough that a shaky hand on the row's edge does not break a split, and no
 * more. It used to also have to stay *inside the strip*, which on a strip that
 * is one row tall means a few pixels of padding — a target nobody can hit, so
 * dragging a chip out of its pair read as not working at all.
 */
const DETACH_MARGIN_PX = 8;

function chipIdAt(
  strip: HTMLElement | null,
  x: number,
  y: number,
  skipId: string,
): string | null {
  if (!strip) return null;
  const chips = strip.querySelectorAll<HTMLElement>(".lc-tab[data-tab-id]");
  for (const chip of chips) {
    const id = chip.dataset.tabId;
    if (!id || id === skipId || id === HOME_TAB_ID) continue;
    if (chip.dataset.tabKind === "cancel") continue;
    if (pointInBox(chip.getBoundingClientRect(), x, y)) return id;
  }
  return null;
}

export function TabStrip({
  tabs,
  groups = [],
  activeId,
  busy = false,
  onFocus,
  onClose,
  activeIndexChip,
  onCancelLoad,
  onTabDrag,
  onTabDrop,
  onTabDragEnd,
  onTabDropOnTab,
  onSplitWithActive,
  onUnsplit,
  groupedIds = [],
  onRename,
}: TabStripProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const skipClickRef = useRef(false);
  const lastTapRef = useRef({ id: "", at: 0 });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  /*
   * The chip that is currently being carried, and where.
   *
   * Without this the gesture had no picture: you pressed a tab, dragged, and
   * nothing on screen moved until you happened to reach an edge band. So the
   * drag was indistinguishable from a press that had not registered, which is
   * why it read as broken rather than as undiscovered.
   */
  const [carry, setCarry] = useState<{ id: string; title: string; x: number; y: number } | null>(
    null,
  );
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  /** Dragging a grouped chip clear of its pair — dropping here breaks the split. */
  const [detaching, setDetaching] = useState(false);
  const [cancelHit, setCancelHit] = useState(false);
  /** Last down's pointer type, so a touch long-press `contextmenu` is not a menu. */
  const lastPointerTypeRef = useRef<string>("mouse");
  const cancelTimerRef = useRef<number | null>(null);
  const onCancelLoadRef = useRef(onCancelLoad);
  onCancelLoadRef.current = onCancelLoad;

  // Any scroll, resize or outside press dismisses the chip menu — it is pinned
  // to a viewport point, so it goes stale the moment the strip moves.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (!onCancelLoad) setCancelHit(false);
  }, [onCancelLoad]);

  useEffect(
    () => () => {
      if (cancelTimerRef.current != null) window.clearTimeout(cancelTimerRef.current);
    },
    [],
  );

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

  /*
   * A split's two halves are drawn side by side, in the group's own order.
   *
   * They can be anywhere in `tabs` — the pair is made by dragging one chip
   * onto the other, not by them happening to be neighbours — so the
   * render order is rebuilt here. The strip itself does not layout-animate;
   * the canvas is what swaps.
   */
  const rows = useMemo(() => {
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));
    const seen = new Set<string>();
    const out: Array<{ group: TabGroup | null; members: TabRecord[] }> = [];
    for (const tab of tabs) {
      if (seen.has(tab.id)) continue;
      /*
       * Home is the wordmark, not a chip.
       *
       * It competed for width with the documents actually open, and shrinking it
       * to an icon left a gap in the strip instead — a landmark that fits in the
       * corner every application already uses for it has no reason to spend a
       * tab slot as well. The tab still exists in state; it is simply not drawn
       * here, so focusing it and closing back to it work exactly as before.
       */
      if (tab.kind === "home") {
        seen.add(tab.id);
        continue;
      }
      const group = tab.group ? (groups.find((g) => g.id === tab.group) ?? null) : null;
      if (!group) {
        seen.add(tab.id);
        out.push({ group: null, members: [tab] });
        continue;
      }
      const members = group.children
        .map((id) => byId.get(id))
        .filter((member): member is TabRecord => Boolean(member));
      for (const member of members) seen.add(member.id);
      out.push({ group, members });
    }
    return out;
  }, [groups, tabs]);

  const still = useReducedMotion();

  const commitRename = (id: string, value: string) => {
    setRenamingId(null);
    const next = value.trim();
    if (!next) return;
    const current = tabs.find((tab) => tab.id === id)?.title;
    if (current === next) return;
    onRename?.(id, next);
  };

  /*
   * Would dropping here take the chip out of its split?
   *
   * Dragging one chip onto another makes a pair, so dragging one off its pair
   * should break it — the same gesture, run backwards, which is the only reason
   * anyone would guess it works. Right-click → Unsplit stays, but it was the
   * *only* way, and a right-click is not something you have on a tablet.
   *
   * Anywhere clear of the pair's own row, including out over the board. This
   * used to require staying inside the strip as well, which on a strip one row
   * tall leaves a few pixels of padding to aim at — so the gesture existed and
   * could not be performed. Nothing else claims a drop outside the strip, so
   * there is no second meaning for one to collide with.
   *
   * Landing on another chip is still a pairing, not a detach: that drop has its
   * own answer, and it is the more specific of the two.
   */
  const wouldDetach = (tabId: string, groupId: string | undefined, x: number, y: number) => {
    if (!groupId) return false;
    const strip = stripRef.current;
    if (!strip) return false;
    if (chipIdAt(strip, x, y, tabId)) return false;
    /*
     * Matched in JS rather than through a selector.
     *
     * `CSS.escape` is missing from older WebViews — the same reason
     * `docAnchors` avoids it — and the cost of its absence here is total:
     * `wouldDetach` runs inside a pointer handler, so a throw takes the whole
     * drag with it and the chip simply stops responding.
     */
    const row =
      Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-row-group]")).find(
        (candidate) => candidate.dataset.tabRowGroup === groupId,
      ) ?? null;
    if (!row) return false;
    return distanceOutside(row.getBoundingClientRect(), x, y) > DETACH_MARGIN_PX;
  };

  return (
    <div className="lc-tab-strip" role="tablist" aria-label="Open workspaces" ref={stripRef}>
      {rows.map((row) => (
        <div
          key={row.group ? row.group.id : row.members[0]!.id}
          className={row.group ? "lc-tab-row is-group" : "lc-tab-row"}
          data-tab-row-group={row.group?.id ?? undefined}
        >
          {row.group ? <span className="lc-tab-group-frame" aria-hidden /> : null}
          {row.members.map((tab) => {
        const selected = tab.id === activeId;
        const indexState = indexStateOf(tab);
        // Home abandons an in-flight load, but it never stops saying Home.
        const cancelling = false;
        const label = tab.title;
        const homeAborts = tab.kind === "home" && Boolean(onCancelLoad);
        const grouped = Boolean(tab.group);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={selected}
            data-tab-active={selected ? "true" : "false"}
            data-tab-kind={cancelling ? "cancel" : tab.kind}
            data-tab-id={tab.id}
            data-tab-group={tab.group ?? undefined}
            className={[
              cancelling ? "lc-tab is-cancelling" : selected ? "lc-tab is-active" : "lc-tab",
              grouped ? "is-grouped" : "",
              carry?.id === tab.id ? "is-carrying" : "",
              dropTargetId === tab.id ? "is-drop-target" : "",
              cancelling && cancelHit ? "is-cancel-hit" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <button
              type="button"
              className="lc-tab-hit"
              title={
                tab.id === HOME_TAB_ID
                  ? homeAborts
                    ? "Home — stops the page that is loading"
                    : tab.title
                  : `${tab.title}\nDrag onto another tab to split · right-click for more`
              }
              aria-label={label}
              onClick={() => {
                if (skipClickRef.current) {
                  skipClickRef.current = false;
                  return;
                }
                if (homeAborts) onCancelLoadRef.current?.();
                if (!cancelling) {
                  if (onRename && tabAllowsRename(tab)) {
                    const now = Date.now();
                    if (lastTapRef.current.id === tab.id && now - lastTapRef.current.at < DOUBLE_TAP_MS) {
                      lastTapRef.current = { id: "", at: 0 };
                      setRenamingId(tab.id);
                      setRenameDraft(tab.title);
                      return;
                    }
                    lastTapRef.current = { id: tab.id, at: now };
                  }
                  onFocus(tab.id);
                  return;
                }
                if (cancelHit || cancelTimerRef.current != null) return;
                setCancelHit(true);
                if (still) {
                  onCancelLoadRef.current?.();
                  return;
                }
                cancelTimerRef.current = window.setTimeout(() => {
                  cancelTimerRef.current = null;
                  onCancelLoadRef.current?.();
                }, CANCEL_HIT_MS);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (cancelling || tab.id === HOME_TAB_ID) return;
                // Android WebView fires this on a finger hold. That hold is a
                // drag, same as desktop; the ⋯ button is the touch menu.
                if (lastPointerTypeRef.current !== "mouse") return;
                setMenu({ id: tab.id, x: event.clientX, y: event.clientY });
              }}
              /*
                No `disabled` while busy.
                
                A tab you are waiting for is exactly the one you want to leave
                for a minute, and the workspaces stay mounted — the load is
                still running when you come back. Dragging stays blocked below,
                because re-arranging tabs under a load is how a split ends up
                half-built.
              */
              onPointerDown={(event) => {
                lastPointerTypeRef.current = event.pointerType;
                if (renamingId === tab.id) return;
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
                const onto = chipIdAt(stripRef.current, event.clientX, event.clientY, tab.id);
                setDropTargetId(onto);
                setDetaching(
                  wouldDetach(tab.id, tab.group, event.clientX, event.clientY),
                );
                setCarry({ id: tab.id, title: tab.title, x: event.clientX, y: event.clientY });
                onTabDrag?.(tab.id, event.clientX, event.clientY);
              }}
              onPointerUp={(event) => {
                const drag = dragRef.current;
                if (!drag || drag.id !== tab.id) return;
                if (drag.moved) {
                  skipClickRef.current = true;
                  const onto = chipIdAt(stripRef.current, event.clientX, event.clientY, tab.id);
                  if (onto) onTabDropOnTab?.(tab.id, onto);
                  else if (wouldDetach(tab.id, tab.group, event.clientX, event.clientY)) {
                    onUnsplit?.(tab.id);
                  }
                  onTabDrop?.(tab.id, event.clientX, event.clientY);
                }
                dragRef.current = null;
                setCarry(null);
                setDropTargetId(null);
                setDetaching(false);
                onTabDragEnd?.();
              }}
              onPointerCancel={() => {
                dragRef.current = null;
                setCarry(null);
                setDropTargetId(null);
                setDetaching(false);
                onTabDragEnd?.();
              }}
            >
              <TabIcon kind={cancelling ? "cancel" : tab.kind} />
              {renamingId === tab.id ? (
                <input
                  className="lc-tab-title-input"
                  value={renameDraft}
                  aria-label={`Rename ${tab.title}`}
                  autoFocus
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={(event) => commitRename(tab.id, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename(tab.id, (event.target as HTMLInputElement).value);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingId(null);
                    }
                  }}
                />
              ) : (
                <span className="lc-tab-title">{label}</span>
              )}
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
            {tab.id === HOME_TAB_ID || isFootnoteBoardTab(tab) ? null : (
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
      ))}

      {/*
        * The chip under the pointer. Portalled to the body because the strip
        * clips its own overflow — a ghost drawn inside it would be sliced off
        * the moment it left the header, which is the entire journey.
        */}
      {carry
        ? createPortal(
            <div
              className={detaching ? "lc-tab-ghost is-detach" : "lc-tab-ghost"}
              aria-hidden
              style={{ transform: `translate3d(${carry.x}px, ${carry.y}px, 0)` }}
            >
              {detaching ? "Unsplit" : carry.title}
            </div>,
            document.body,
          )
        : null}

      {menu
        ? createPortal(
            <>
              <button
                type="button"
                className="lc-tab-menu-backdrop"
                aria-label="Dismiss tab actions"
                onClick={() => setMenu(null)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu(null);
                }}
              />
              <div
                className="lc-tab-menu"
                role="menu"
                style={{ top: menu.y, left: menu.x }}
                onClick={(event) => event.stopPropagation()}
              >
                {groupedIds.includes(menu.id) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onUnsplit?.(menu.id);
                      setMenu(null);
                    }}
                  >
                    Unsplit
                  </button>
                ) : (
                  <>
                    {/* Splitting needs a partner, and the partner is whatever
                        is already on screen — so the open tab cannot split
                        with itself. */}
                    <button
                      type="button"
                      role="menuitem"
                      disabled={menu.id === activeId}
                      onClick={() => {
                        onSplitWithActive?.(menu.id, "right");
                        setMenu(null);
                      }}
                    >
                      Split
                    </button>
                  </>
                )}
                {tabs.some((tab) => tab.id === menu.id && !isFootnoteBoardTab(tab)) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onClose(menu.id);
                      setMenu(null);
                    }}
                  >
                    Close
                  </button>
                ) : null}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
