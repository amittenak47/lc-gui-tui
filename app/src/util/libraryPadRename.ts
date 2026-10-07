/**
 * Rename a library pad without treating it as a new edit.
 *
 * Writes the local index (no `updatedAt` bump), then pushes the existing body
 * so the hub sees the new title/label. Recent order stays put.
 */

import type { LcClient } from "../api/client";
import { setAnnotateDocLabel } from "./annotateStore";
import { isFootnoteBoardTab, type TabRecord } from "./tabs";
import {
  renameWhiteboardNotebook,
} from "./whiteboardStore";

export function tabAllowsRename(tab: TabRecord): boolean {
  if (tab.artifact) return false; // Rename inside the revision-checked attachment editor.
  if (
    tab.kind === "home" ||
    tab.kind === "practice" ||
    tab.kind === "explore"
  ) {
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
  _client: LcClient,
  kind: "whiteboard" | "annotate",
  id: string,
  title: string,
): Promise<boolean> {
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (kind === "whiteboard") {
    if (!await renameWhiteboardNotebook(id, trimmed)) return false;
    return true;
  }
  if (!await setAnnotateDocLabel(id, trimmed)) return false;
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
