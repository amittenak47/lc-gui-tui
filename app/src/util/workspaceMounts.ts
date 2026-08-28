/**
 * Which workspaces are mounted, and how each one is laid out.
 *
 * React reconciles children per parent *position*, not per key alone: a keyed
 * node moved from one `.map()` to another is unmounted and mounted again even
 * though its key never changed. The shell used to render parked, on-screen and
 * overlay workspaces as three separate arrays, so an ordinary tab switch —
 * which moves a tab from one of those arrays to another — remounted both the
 * outgoing and the incoming workspace. That threw away editor state, pending
 * canvas edits and warm pdf.js workers, and defeated the two-workspace cache
 * the mount budget exists to provide.
 *
 * So: one list, one `.map()`, and visibility is a *prop*. `showing` and
 * `splitRole` drive the CSS (`lc-canvas-parked`, `is-split-a`, `lc-canvas-over`);
 * nothing about being parked or on screen changes where a workspace lives in
 * the tree.
 */

/** A mounted tab as the live-set memo describes it. */
export type LiveTabEntry<T> = {
  tab: T;
  active: boolean;
  showing: boolean;
};

/** One mounted tab, with the layout it should render at. */
export type WorkspaceMount<T> = LiveTabEntry<T> & {
  /** Which half of a split it occupies, or null when it is not in one. */
  splitRole: "a" | "b" | null;
  /** Whether the shell is currently laying it out. */
  onScreen: boolean;
};

/**
 * The mount key for a workspace.
 *
 * Retry generations are per tab, and deliberately independent of `active`:
 * a key that changes when a tab gains or loses focus remounts on every switch,
 * which is what one global retry token did to *every* tab after the first
 * "Try again".
 */
export function workspaceMountKey(
  tabId: string,
  retryByTab: Record<string, number>,
): string {
  return `${tabId}:${retryByTab[tabId] ?? 0}`;
}

/** Bump only this tab's retry generation. */
export function bumpRetry(
  retryByTab: Record<string, number>,
  tabId: string,
): Record<string, number> {
  return { ...retryByTab, [tabId]: (retryByTab[tabId] ?? 0) + 1 };
}

/**
 * The single render list.
 *
 * Order follows the live set, then any on-screen tab the live set has not
 * caught up with yet. DOM order does not decide layout — the split halves take
 * `order: 1` / `order: 3` around the sash, parked ones are `display: none`, and
 * the Home overlay is absolutely positioned — so keeping this order stable is
 * exactly what keeps the workspaces mounted.
 */
export function planWorkspaceMounts<T extends { id: string }>(input: {
  liveTabs: LiveTabEntry<T>[];
  /** Every known tab, for an on-screen id the live set is missing. */
  allTabs: T[];
  visibleIds: string[];
  /** The active split group's children, or null when there is no split. */
  groupChildren: string[] | null;
  activeId: string;
}): WorkspaceMount<T>[] {
  const { liveTabs, allTabs, visibleIds, groupChildren, activeId } = input;

  const entries = [...liveTabs];
  const mounted = new Set(entries.map((entry) => entry.tab.id));
  for (const id of visibleIds) {
    if (mounted.has(id)) continue;
    const tab = allTabs.find((entry) => entry.id === id);
    if (!tab) continue;
    mounted.add(id);
    entries.push({ tab, active: id === activeId, showing: true });
  }

  return entries.map((entry) => {
    const splitIndex = groupChildren ? groupChildren.indexOf(entry.tab.id) : -1;
    const onScreen = groupChildren ? splitIndex >= 0 : visibleIds.includes(entry.tab.id);
    return {
      ...entry,
      onScreen,
      showing: entry.showing || onScreen,
      splitRole: splitIndex === 0 ? "a" : splitIndex === 1 ? "b" : null,
    };
  });
}
