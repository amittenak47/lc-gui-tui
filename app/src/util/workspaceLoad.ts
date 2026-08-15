/**
 * Busy strings that mean a workspace / pad is still opening — not coach ask,
 * not save, not a generic wait. The header ← cancels these.
 */
export const WORKSPACE_LOAD_BUSY = [
  "loading the workspace…",
  "opening offline…",
  "opening whiteboard…",
  "opening document…",
] as const;

export function isWorkspaceLoadBusy(busy: string | null): boolean {
  if (busy === null) return false;
  return (WORKSPACE_LOAD_BUSY as readonly string[]).includes(busy);
}

export function workspaceLoadHomeLabel(busy: string | null): boolean {
  return busy === "opening whiteboard…" || busy === "opening document…";
}
