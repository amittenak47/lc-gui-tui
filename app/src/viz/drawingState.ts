/**
 * Coach drawings ride on chat messages — expand/collapse controls the board,
 * and the full VizProgram is what gets persisted in agent.json.
 */

import { parseVizProgram, type VizProgram } from "./schema";

export const MAX_VISIBLE_DRAWINGS = 4;

export interface MessageDrawing {
  program: VizProgram;
  /** When true, the diagram is shown in the coach lane. */
  expanded: boolean;
  /**
   * Replaced by a newer drawing when the lane was full. The program is kept so
   * the student can expand it again; the chat section shows [redacted].
   */
  redacted?: boolean;
  /** Scrubber position for multi-frame programs. */
  frameIndex?: number;
}

export function isDrawingVisible(drawing: MessageDrawing | undefined): boolean {
  return Boolean(drawing && drawing.expanded && !drawing.redacted);
}

/** Programs currently meant to be on the coach lane, in message order. */
export function visibleDrawings(
  messages: ReadonlyArray<{ drawing?: MessageDrawing }>,
): MessageDrawing[] {
  return messages.map((message) => message.drawing).filter(isDrawingVisible) as MessageDrawing[];
}

/**
 * Mark the oldest visible drawing as collapsed + redacted so a new one can take
 * its slot. Returns a new messages array.
 */
export function redactOldestVisibleDrawing<T extends { drawing?: MessageDrawing }>(
  messages: readonly T[],
): T[] {
  const oldestId = visibleDrawings(messages)[0]?.program.id;
  if (!oldestId) return [...messages];
  return messages.map((message) => {
    if (message.drawing?.program.id !== oldestId) return message;
    return {
      ...message,
      drawing: {
        ...message.drawing,
        expanded: false,
        redacted: true,
      },
    };
  });
}

/** Cap visible drawings to the lane capacity by redacting oldest first. */
export function enforceVisibleDrawingCap<T extends { drawing?: MessageDrawing }>(
  messages: readonly T[],
  cap = MAX_VISIBLE_DRAWINGS,
  /** Prefer not to redact this program (the one just expanded / added). */
  keepProgramId?: string,
): T[] {
  let next = [...messages];
  while (visibleDrawings(next).length > cap) {
    const visibles = visibleDrawings(next);
    const victim =
      visibles.find((drawing) => drawing.program.id !== keepProgramId) ?? visibles[0];
    if (!victim) break;
    next = next.map((message) => {
      if (message.drawing?.program.id !== victim.program.id) return message;
      return {
        ...message,
        drawing: {
          ...message.drawing,
          expanded: false,
          redacted: true,
        },
      };
    });
  }
  return next;
}

/** Toggle expand on a message; expanding clears redacted. */
export function setDrawingExpanded<T extends { id: string; drawing?: MessageDrawing }>(
  messages: readonly T[],
  messageId: string,
  expanded: boolean,
): T[] {
  let keepProgramId: string | undefined;
  const toggled = messages.map((message) => {
    if (message.id !== messageId || !message.drawing) return message;
    keepProgramId = message.drawing.program.id;
    return {
      ...message,
      drawing: {
        ...message.drawing,
        expanded,
        redacted: expanded ? false : message.drawing.redacted,
      },
    };
  });
  return expanded
    ? enforceVisibleDrawingCap(toggled, MAX_VISIBLE_DRAWINGS, keepProgramId)
    : toggled;
}

/** Attach a freshly drawn program to an assistant message (expanded). */
export function withNewDrawing(
  program: VizProgram,
): MessageDrawing {
  return { program, expanded: true, frameIndex: 0 };
}

/** Rehydrate a stored drawing blob, or null if unusable. */
export function restoreMessageDrawing(raw: unknown): MessageDrawing | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const program = parseVizProgram(record.program);
  if (!program) return undefined;
  return {
    program,
    expanded: record.expanded === true,
    redacted: record.redacted === true,
    frameIndex: typeof record.frameIndex === "number" ? record.frameIndex : 0,
  };
}
