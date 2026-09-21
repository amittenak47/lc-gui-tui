import type { LcClient } from "../api/client";
import type { ArtifactParent } from "./padArtifacts";
import { getAnnotateDoc } from "./annotateStore";
import { getWhiteboardNotebook } from "./whiteboardStore";
import { getProblemBoard } from "./problemBoardStore";
import { pushAnnotatePad, pushProblemPad, pushWhiteboardPad } from "./padSync";

export async function syncArtifactParent(client: LcClient, parent: ArtifactParent): Promise<boolean> {
  if (parent.kind === "annotate") { const row = await getAnnotateDoc(parent.id); return row && !row.deletedAt ? pushAnnotatePad(client, row) : false; }
  if (parent.kind === "whiteboard") { const row = await getWhiteboardNotebook(parent.id); return row && !row.deletedAt ? pushWhiteboardPad(client, row) : false; }
  const row = await getProblemBoard(parent.id); return row ? pushProblemPad(client, row) : false;
}
