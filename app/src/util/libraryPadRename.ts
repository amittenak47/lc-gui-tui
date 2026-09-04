/**
 * Rename a library pad without treating it as a new edit.
 *
 * Writes the local index (no `updatedAt` bump), then pushes the existing body
 * so the hub sees the new title/label. Recent order stays put.
 */

import type { LcClient } from "../api/client";
import {
  getAnnotateDoc,
  setAnnotateDocLabel,
} from "./annotateStore";
import { pushAnnotatePad, pushWhiteboardPad } from "./padSync";
import { isFootnoteBoardTab, type TabRecord } from "./tabs";
import {
  getWhiteboardNotebook,
  renameWhiteboardNotebook,
} from "./whiteboardStore";

export function tabAllowsRename(tab: TabRecord): boolean {
  if (tab.kind === "home" || tab.kind === "practice" || tab.kind === "explore") {
    return false;
  }
  if (isFootnoteBoardTab(tab)) return false;
  return tab.kind === "whiteboard" || tab.kind === "annotate" || tab.kind === "web";
}

export function libraryIdForTab(tab: TabRecord): string | null {
  if (tab.kind === "whiteboard") return tab.notebookId;
  if (tab.kind === "annotate" || tab.kind === "web") return tab.docId;
  return null;
}

export async function renameLibraryPad(
  client: LcClient,
  kind: "whiteboard" | "annotate",
  id: string,
  title: string,
): Promise<boolean> {
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (kind === "whiteboard") {
    if (!renameWhiteboardNotebook(id, trimmed)) return false;
    const notebook = await getWhiteboardNotebook(id);
    if (notebook) await pushWhiteboardPad(client, notebook);
    return true;
  }
  if (!setAnnotateDocLabel(id, trimmed)) return false;
  const doc = await getAnnotateDoc(id);
  if (doc) await pushAnnotatePad(client, doc);
  return true;
}

export async function renameTabPad(
  client: LcClient,
  tab: TabRecord,
  title: string,
): Promise<boolean> {
  if (!tabAllowsRename(tab)) return false;
  const id = libraryIdForTab(tab);
  if (!id) return false;
  const kind = tab.kind === "whiteboard" ? "whiteboard" : "annotate";
  return renameLibraryPad(client, kind, id, title);
}
