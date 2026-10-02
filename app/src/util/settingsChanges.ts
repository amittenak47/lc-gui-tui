/** Count changed settings, including nested controls; reverting a draft removes it. */
export function countSettingsChanges(draft: unknown, saved: unknown): number {
  if (Object.is(draft, saved)) return 0;
  if (Array.isArray(draft) && Array.isArray(saved)) {
    return Number(draft.length !== saved.length || draft.some((value, index) => countSettingsChanges(value, saved[index]) > 0));
  }
  if (draft && saved && typeof draft === "object" && typeof saved === "object" && !Array.isArray(draft) && !Array.isArray(saved)) {
    const next = draft as Record<string, unknown>, before = saved as Record<string, unknown>;
    return [...new Set([...Object.keys(next), ...Object.keys(before)])].reduce((total, key) => total + countSettingsChanges(next[key], before[key]), 0);
  }
  return 1;
}
