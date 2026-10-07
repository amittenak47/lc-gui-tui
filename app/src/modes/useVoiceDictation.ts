import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  appendSegment,
  cancelVoiceDictation,
  cleanupDictation,
  onVoiceEvent,
  spliceDictation,
  startVoiceDictation,
  stopVoiceDictation,
  voiceDictationAvailable,
  type DictationAnchor,
  type VoiceEvent,
} from "../util/voiceDictation";

export type VoicePhase = "idle" | "listening" | "transcribing" | "cleaning";

export interface VoiceDictation {
  available: boolean; // native recognizer exists (false until voiceDictationAvailable() answers)
  listening: boolean; // a session is live (starting, listening, transcribing, or tidying)
  processing: boolean; // transcribing a clip, or tidying the words after the recognizer ends
  phase: VoicePhase; // idle, listening, transcribing, or cleaning (tidying)
  error: string | null; // last fatal error / start rejection message
  toggle: () => void; // start, or ask the live session to stop (it keeps writing its last words until `end`). While processing, do nothing.
  release: () => void; // drop the live session NOW: unsubscribe, ignore any further events. Cancels the recognizer unless it is already tidying. No-op when idle.
  userTyped: () => void; // no session → no-op. Tidying → drop the session and keep the raw draft (no cancel). Processing → keep the session and mark rebase. Otherwise release().
}

interface DictationSession {
  id: string;
  anchor: DictationAnchor;
  committed: string;
  partial: string;
  unsubscribe: () => void;
  processing: boolean;
  rebase: boolean;
  cleaning: boolean;
  /** Composer text last produced by write(). */
  written: string;
}

export function useVoiceDictation(options: {
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (value: string) => void;
}): VoiceDictation {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const draftRef = useRef(options.draft);
  const setDraftRef = useRef(options.setDraft);
  const fieldRef = useRef(options.fieldRef);
  draftRef.current = options.draft;
  setDraftRef.current = options.setDraft;
  fieldRef.current = options.fieldRef;
  const sessionRef = useRef<DictationSession | null>(null);

  const placeCaret = useCallback((text: string, caret: number) => {
    requestAnimationFrame(() => {
      const el = fieldRef.current.current;
      if (!el || el.value !== text) return;
      el.setSelectionRange(caret, caret);
    });
  }, []);

  const write = useCallback((session: DictationSession) => {
    const { text, caret } = spliceDictation(session.anchor, session.committed, session.partial);
    session.written = text;
    setDraftRef.current(text);
    placeCaret(text, caret);
  }, [placeCaret]);

  const drop = useCallback((session: DictationSession) => {
    session.unsubscribe();
    if (sessionRef.current === session) sessionRef.current = null;
    setListening(false);
    setProcessing(false);
    setPhase("idle");
  }, []);

  const release = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const cleaning = session.cleaning;
    drop(session);
    if (!cleaning) void cancelVoiceDictation(session.id);
  }, [drop]);

  const userTyped = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.cleaning) {
      drop(session);
      return;
    }
    if (session.processing) {
      session.rebase = true;
      return;
    }
    release();
  }, [drop, release]);

  const toggle = useCallback(() => {
    const live = sessionRef.current;
    if (live?.processing) return;
    if (live) {
      void stopVoiceDictation(live.id);
      return;
    }
    setError(null);
    const draft = draftRef.current;
    const field = fieldRef.current.current;
    const start = field ? field.selectionStart : draft.length;
    const end = field ? field.selectionEnd : draft.length;
    const session: DictationSession = {
      id: crypto.randomUUID(),
      anchor: { before: draft.slice(0, start), after: draft.slice(end) },
      committed: "",
      partial: "",
      unsubscribe: () => {},
      processing: false,
      rebase: false,
      cleaning: false,
      written: "",
    };
    const onEvent = (event: VoiceEvent) => {
      if (sessionRef.current !== session || event.sessionId !== session.id || session.cleaning) return;
      switch (event.type) {
        case "partial":
          session.partial = event.text;
          write(session);
          return;
        case "final":
          if (session.rebase) {
            const current = draftRef.current;
            const el = fieldRef.current.current;
            const selectionStart = el ? el.selectionStart : current.length;
            const selectionEnd = el ? el.selectionEnd : current.length;
            session.anchor = {
              before: current.slice(0, selectionStart),
              after: current.slice(selectionEnd),
            };
            session.committed = "";
            session.partial = "";
            session.rebase = false;
          }
          session.committed = appendSegment(session.committed, event.text);
          session.partial = "";
          write(session);
          return;
        case "limit":
          if (session.processing) return;
          setError("Recording stopped at the 15-minute limit. Transcribing the recorded clip.");
          session.processing = true;
          setProcessing(true);
          setPhase("transcribing");
          void stopVoiceDictation(session.id);
          return;
        case "processing":
          session.processing = true;
          setProcessing(true);
          setPhase("transcribing");
          return;
        case "error":
          setError(event.message);
          return;
        case "state":
          return;
        case "end": {
          // Retire the native session identity; its text is already local.
          void cancelVoiceDictation(session.id);
          const words = appendSegment(session.committed, session.partial);
          if (!words) {
            drop(session);
            return;
          }
          const rawText = session.written || spliceDictation(session.anchor, session.committed, session.partial).text;
          session.cleaning = true;
          session.processing = true;
          setProcessing(true);
          setListening(true);
          setPhase("cleaning");
          void (async () => {
            const cleaned = await cleanupDictation(words);
            if (sessionRef.current !== session) return;
            if (draftRef.current === rawText && cleaned !== words) {
              const { text, caret } = spliceDictation(session.anchor, cleaned, "");
              setDraftRef.current(text);
              placeCaret(text, caret);
            }
            if (sessionRef.current !== session) return;
            drop(session);
          })();
          return;
        }
      }
    };
    sessionRef.current = session;
    session.unsubscribe = onVoiceEvent(onEvent);
    setListening(true);
    setPhase("listening");
    void startVoiceDictation(session.id).catch((err: unknown) => {
      if (sessionRef.current !== session) return;
      drop(session);
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [drop, placeCaret, write]);

  useEffect(() => {
    let alive = true;
    void voiceDictationAvailable().then((ok) => {
      if (!alive) return;
      // `false` is already the state. Setting it again still schedules a
      // render while the panel is settling, which the composer tests flag.
      if (ok) setAvailable(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => () => release(), [release]);

  return { available, listening, processing, phase, error, toggle, release, userTyped };
}
