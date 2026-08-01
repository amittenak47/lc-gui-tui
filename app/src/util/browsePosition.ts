/**
 * Remember where the problem browser left off — dataset tab, filters, page.
 */

import { DEFAULT_DATASET } from "../api/types";

const STORAGE_KEY = "lc.browse.position.v1";

export interface BrowsePosition {
  dataset: string;
  query: string;
  difficulty: string;
  tag: string;
  sort: string;
  page: number;
  selected: number;
}

const DEFAULTS: BrowsePosition = {
  dataset: DEFAULT_DATASET,
  query: "",
  difficulty: "",
  tag: "",
  sort: "task_id",
  page: 0,
  selected: 0,
};

export function loadBrowsePosition(): BrowsePosition {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<BrowsePosition>;
    return {
      dataset: typeof parsed.dataset === "string" ? parsed.dataset : DEFAULTS.dataset,
      query: typeof parsed.query === "string" ? parsed.query : DEFAULTS.query,
      difficulty: typeof parsed.difficulty === "string" ? parsed.difficulty : DEFAULTS.difficulty,
      tag: typeof parsed.tag === "string" ? parsed.tag : DEFAULTS.tag,
      sort: typeof parsed.sort === "string" ? parsed.sort : DEFAULTS.sort,
      page: typeof parsed.page === "number" && parsed.page >= 0 ? Math.floor(parsed.page) : 0,
      selected:
        typeof parsed.selected === "number" && parsed.selected >= 0
          ? Math.floor(parsed.selected)
          : 0,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveBrowsePosition(position: BrowsePosition): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
  } catch {
    /* private browsing */
  }
}
