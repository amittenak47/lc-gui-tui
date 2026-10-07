/**
 * Microphone dictation for the agent composer, on Android only.
 *
 * The page cannot run the recognizer itself: speech is a native service, and
 * a desktop build has none. The composer asks the shell to start and stop,
 * and the shell pushes what it heard as window events. A partial replaces the
 * guess for the current segment; a final commits that segment, and the next
 * partial starts a new one. Spoken words replace the textarea selection that
 * was current when listening began.
 */

import { isAndroidDevice } from "./androidDevice";

export const VOICE_EVENT = "lc-voice";

export type VoiceEvent = { sessionId: string } & (
  | { type: "state"; listening: boolean }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "processing" }
  | { type: "error"; code: string; message: string }
  | { type: "limit" }
  | { type: "end" });

// One answer for the life of the page. The shell does not grow a recognizer later.
let known: Promise<boolean> | null = null;

/**
 * Whether the native recognizer exists here. Cached after the first answer.
 * False off Android, outside Tauri, or if the invoke throws — a throw is not
 * cached, so a probe that failed during startup is asked again next time.
 */
export function voiceDictationAvailable(): Promise<boolean> {
  if (known) return known;
  known = ask().catch(() => {
    known = null;
    return false;
  });
  return known;
}

async function ask(): Promise<boolean> {
  if (typeof window === "undefined" || !isAndroidDevice()) return false;
  if (!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  const ok = await invoke<boolean>("voice_available");
  return ok === true;
}

/** Rejects with an Error whose message is the native message (string rejections are wrapped). */
export async function startVoiceDictation(sessionId: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("voice_start", { sessionId });
  } catch (err) {
    if (typeof err === "string") throw new Error(err);
    throw err;
  }
}

/** Never rejects. */
export async function stopVoiceDictation(sessionId: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("voice_stop", { sessionId });
  } catch {
    // Stopping is best-effort: the recognizer may already be gone.
  }
}

/** Best-effort tidy of dictated words. Any failure leaves `text` as it was. */
export async function cleanupDictation(text: string): Promise<string> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("voice_cleanup", { text });
  } catch {
    return text;
  }
}

/** Drop the session without transcribing. Never rejects. */
export async function cancelVoiceDictation(sessionId: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("voice_cancel", { sessionId });
  } catch {
    // Cancelling is best-effort: the session may already be gone.
  }
}

function isVoiceEvent(detail: unknown): detail is VoiceEvent {
  if (!detail || typeof detail !== "object") return false;
  const value = detail as {
    sessionId?: unknown;
    type?: unknown;
    listening?: unknown;
    text?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (typeof value.sessionId !== "string" || !value.sessionId) return false;
  switch (value.type) {
    case "state":
      return typeof value.listening === "boolean";
    case "partial":
    case "final":
      return typeof value.text === "string";
    case "error":
      return typeof value.code === "string" && typeof value.message === "string";
    case "limit":
    case "processing":
    case "end":
      return true;
    default:
      return false;
  }
}

/** Listen for native events. Ignores events whose detail does not match VoiceEvent (validate `type` and field types). Returns an unsubscribe function. */
export function onVoiceEvent(listener: (event: VoiceEvent) => void): () => void {
  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!isVoiceEvent(detail)) return;
    listener(detail);
  };
  window.addEventListener(VOICE_EVENT, onEvent);
  return () => window.removeEventListener(VOICE_EVENT, onEvent);
}

/** Text on either side of where dictation was started (the textarea selection, which dictation replaces). */
export interface DictationAnchor {
  before: string;
  after: string;
}

/** Join a finished segment onto what has been committed so far: trimmed, single space between, empty segments ignored. */
export function appendSegment(committed: string, segment: string): string {
  const next = segment.trim();
  if (!next) return committed;
  const prev = committed.trim();
  if (!prev) return next;
  return `${prev} ${next}`;
}

/**
 * The composer text with dictated words in place, and where the caret goes (just after the spoken words).
 * spoken = appendSegment(committed, partial).
 * A space is inserted between `before` and the spoken words when `before` is non-empty and does not already end in whitespace;
 * likewise between the spoken words and `after` when `after` is non-empty and does not start with whitespace.
 * No spaces are added when `spoken` is empty (the result is then exactly before + after, caret = before.length).
 */
export function spliceDictation(
  anchor: DictationAnchor,
  committed: string,
  partial: string,
): { text: string; caret: number } {
  const spoken = appendSegment(committed, partial);
  if (!spoken) {
    return { text: anchor.before + anchor.after, caret: anchor.before.length };
  }
  const lead = anchor.before && !/\s$/.test(anchor.before) ? " " : "";
  const trail = anchor.after && !/^\s/.test(anchor.after) ? " " : "";
  const head = anchor.before + lead + spoken;
  return { text: head + trail + anchor.after, caret: head.length };
}
