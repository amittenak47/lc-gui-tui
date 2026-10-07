/** Defined optional DTO members use omission on the wire. Unknown values are
 * left intact so canonical JSON still rejects unrepresentable user fields. */
const messageOptional = ["requestId", "retryOf", "requestState", "requestNote", "queued", "review", "bridge", "attachments",
  "artifacts", "artifactProposals", "artifactFootnoteIds", "flags", "processEvents", "reasoning", "drawing", "replyTo", "sessionId", "deletedAt", "pending", "pendingAck", "bridgePending", "bridgeError"];
const noteOptional = ["captureId", "updatedAt", "threads", "threadRootId", "png", "query", "url", "notes", "whiteboards", "artifacts", "userLinks", "color", "palette", "title", "bands", "blockText", "subMarks"];
export function bookWireRecord(value: Record<string, unknown>): Record<string, unknown> {
  const record = structuredClone(value);
  const omit = (rows: unknown, names: string[]) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) if (row && typeof row === "object") for (const name of names) {
      if (Object.hasOwn(row, name) && row[name] === undefined) delete row[name];
    }
  };
  omit(record.agent, messageOptional); omit(record.footnotes, noteOptional);
  // Inline problem ink remains authored record content. Its known codec
  // buffers have the same numeric-key JSON representation as legacy transport.
  const board = record.board as { inkC?: { ops?: unknown[] } } | undefined;
  for (const op of board?.inkC?.ops ?? []) if (op && typeof op === "object") {
    const row = op as Record<string, unknown>;
    for (const channel of ["xy", "pr", "sl", "rr"]) if (row[channel] instanceof Int16Array || row[channel] instanceof Uint8Array || row[channel] instanceof Uint16Array) {
      row[channel] = Object.fromEntries(Array.from((row[channel] as Int16Array).entries()));
    }
  }
  return record;
}
