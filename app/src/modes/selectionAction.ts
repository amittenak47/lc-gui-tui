export interface SelectionActionContext { isCurrent(): boolean }
export type SelectionActionResult = boolean | void | SelectionActionFailure;
export interface SelectionActionFailure {
  ok: false;
  error: string;
  continueTextOnly?: () => SelectionActionResult | Promise<SelectionActionResult>;
}

/** Invalidates async completions when a selection is replaced or dismissed. */
export function createSelectionActionGate() {
  let generation = 0;
  return {
    reset() { generation++; },
    begin(): SelectionActionContext {
      const current = ++generation;
      return { isCurrent: () => current === generation };
    },
  };
}

/** Only an explicit click can continue a failed image request as text. */
export function selectionCaptureFailure(
  error: string,
  text: string,
  context: SelectionActionContext,
  continueWithText: () => void,
): SelectionActionFailure {
  return {
    ok: false,
    error,
    ...(text.trim() ? { continueTextOnly: () => {
      if (!context.isCurrent()) return false;
      try { continueWithText(); return true; }
      catch (cause) { return { ok: false as const, error: cause instanceof Error ? cause.message : String(cause) }; }
    } } : {}),
  };
}
