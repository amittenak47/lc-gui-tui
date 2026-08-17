/**
 * Problem-browser sort keys and direction, shared by the table headers,
 * offline pack search, and the `sort=` query the daemon already understands.
 *
 * Bare `question` is ascending. Bare `cases` stays descending (the SQL default).
 * Explicit `:asc` / `:desc` / a leading `-` override that.
 */

export const SORTS = ["task_id", "question", "difficulty", "cases", "tags"] as const;
export type SortKey = (typeof SORTS)[number];

export const COLUMN_SORT: Record<string, SortKey> = {
  question: "question",
  task_id: "task_id",
  difficulty: "difficulty",
  tags: "tags",
  cases: "cases",
};

export interface ParsedSort {
  key: SortKey;
  desc: boolean;
}

export function isSortKey(value: string): value is SortKey {
  return (SORTS as readonly string[]).includes(value);
}

export function defaultSortDesc(key: SortKey): boolean {
  return key === "cases";
}

export function parseSort(raw: string | undefined): ParsedSort {
  if (!raw) return { key: "task_id", desc: false };
  let text = raw.toLowerCase();
  let forced: boolean | null = null;
  if (text.startsWith("-")) {
    forced = true;
    text = text.slice(1);
  } else if (text.endsWith(":desc")) {
    forced = true;
    text = text.slice(0, -5);
  } else if (text.endsWith(":asc")) {
    forced = false;
    text = text.slice(0, -4);
  }
  const key: SortKey = isSortKey(text) ? text : "task_id";
  return { key, desc: forced ?? defaultSortDesc(key) };
}

export function formatSort(key: SortKey, desc: boolean): string {
  if (desc === defaultSortDesc(key)) return key;
  return desc ? `${key}:desc` : `${key}:asc`;
}

/** Click a column: that key at default dir, or flip if it is already active. */
export function toggleColumnSort(current: string, column: SortKey): string {
  const parsed = parseSort(current);
  if (parsed.key !== column) return formatSort(column, defaultSortDesc(column));
  return formatSort(column, !parsed.desc);
}

/** Keyboard `O` — next key, that key's default direction. */
export function cycleSortKey(current: string): string {
  const { key } = parseSort(current);
  const index = SORTS.indexOf(key);
  const next = SORTS[(index + 1) % SORTS.length];
  return formatSort(next, defaultSortDesc(next));
}
