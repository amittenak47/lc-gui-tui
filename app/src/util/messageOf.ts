/**
 * Turn anything thrown into a sentence a reader can act on.
 *
 * `String(cause)` is the obvious version and it is wrong for the case that
 * matters: a rejection that is a plain object renders as `[object Object]`,
 * which reached the header banner and told the reader nothing at all. Tauri is
 * the usual source — a command or plugin that rejects with a structured error
 * rather than a string arrives here as exactly that kind of bag.
 *
 * So: read the fields such a bag is likely to carry, and fall back to its JSON
 * rather than to its type name. An ugly `{"code":-32603}` is still evidence;
 * `[object Object]` is not.
 */

/** Fields an error-shaped object is likely to carry, most specific first. */
const MESSAGE_KEYS = ["message", "error", "reason", "detail", "description"] as const;

export function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name || "unknown error";
  if (typeof cause === "string") return cause;
  if (cause == null) return "unknown error";
  if (typeof cause === "object") {
    const bag = cause as Record<string, unknown>;
    for (const key of MESSAGE_KEYS) {
      const value = bag[key];
      if (typeof value === "string" && value.trim()) return value;
      // One level down: `{ error: { message } }` is common in JSON APIs.
      if (value && typeof value === "object") {
        const inner = (value as Record<string, unknown>).message;
        if (typeof inner === "string" && inner.trim()) return inner;
      }
    }
    try {
      const json = JSON.stringify(cause);
      if (json && json !== "{}" && json !== "null") return json;
    } catch {
      // Circular, or a getter that threw. Nothing readable in there.
    }
    return "unknown error";
  }
  return String(cause);
}


/**
 * A running account of what an open actually did, printed to the console.
 *
 * Opening a document fails silently in more than one place — a guard that
 * returns before the try block, a generation check that bails mid-flight —
 * and each of those leaves a different half-built state behind. Reading the
 * code cannot tell you which one you hit; the last line this prints can.
 *
 * `console.info` with a fixed prefix so it survives a WebView and is greppable
 * in `adb logcat` as well as in DevTools.
 */
export function traceOpen(step: string, detail?: Record<string, unknown>): void {
  try {
    // eslint-disable-next-line no-console
    console.info(`[lc:open] ${step}`, detail ? JSON.stringify(detail) : "");
  } catch {
    /* logging must never be the thing that breaks an open */
  }
}
