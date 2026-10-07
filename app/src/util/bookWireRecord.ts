/** Defined optional DTO members use omission on the wire. Unknown values are
 * left intact so canonical JSON still rejects unrepresentable user fields. */
const messageOptional = ["requestId", "retryOf", "requestState", "requestNote", "queued", "review", "bridge", "attachments",
  "artifacts", "artifactProposals", "artifactFootnoteIds", "flags", "processEvents", "reasoning", "drawing", "replyTo", "sessionId", "deletedAt", "pending", "pendingAck", "bridgePending", "bridgeError"];
const noteOptional = ["captureId", "updatedAt", "threads", "threadRootId", "png", "query", "url", "notes", "whiteboards", "artifacts", "userLinks", "color", "palette", "title", "bands", "blockText", "subMarks"];
const processOptional = ["updateId", "detail", "status"];
export function bookWireRecord(value: Record<string, unknown>): Record<string, unknown> {
  const record = structuredClone(value);
  const omit = (rows: unknown, names: string[]) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) if (row && typeof row === "object") for (const name of names) {
      if (Object.hasOwn(row, name) && row[name] === undefined) delete row[name];
    }
  };
  omit(record.agent, messageOptional); omit(record.footnotes, noteOptional);
  if (Array.isArray(record.agent)) for (const message of record.agent) {
    if (message && typeof message === "object") omit(message.processEvents, processOptional);
  }
  // Inline saved ink remains authored record content. Its known codec
  // buffers have the same numeric-key JSON representation as legacy transport.
  const convertBoard = (board: unknown) => {
    const ink = (board as { inkC?: { ops?: unknown[] } } | undefined)?.inkC;
    for (const op of ink?.ops ?? []) if (op && typeof op === "object") {
      const row = op as Record<string, unknown>;
      for (const channel of ["xy", "pr", "sl", "rr"]) if (row[channel] instanceof Int16Array || row[channel] instanceof Uint8Array || row[channel] instanceof Uint16Array) {
        row[channel] = Object.fromEntries(Array.from((row[channel] as Int16Array).entries()));
      }
    }
  };
  convertBoard(record.board);
  // Snapshots use the local camel-case name, live records use the wire name.
  for (const field of ["footnote_boards", "footnoteBoards"]) {
    const children = record[field];
    if (children && typeof children === "object" && !Array.isArray(children)) {
      for (const child of Object.values(children)) if (child && typeof child === "object") convertBoard(child.board);
    }
  }
  return record;
}
