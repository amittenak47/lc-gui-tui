/** Existing split UI supplies choices; the synchronizer performs guarded writes. */
import type { AnnotatePadDto, InkPageDto, WhiteboardPadDto } from "../api/client";
import { bytesToB64 } from "../api/nativeHttp";
import type { BookConflict, BookResolution } from "./bookSync";
import type { ConflictUiLifecycle } from "./conflictUiWait";
import { encodedFromRecord } from "./inkPageStore";
import { packEncodedInk } from "../canvas/inkCodec";
import { localPageKey } from "./bookSnapshot";
import { inkChoiceOf, type HubConflictResolution, type HubPadConflict } from "./hubConflictStash";
import { mergeAgentMessages } from "../modes/coachSessions";
import { bookDisplay, bookConflictMessage } from "./bookSyncMessages";

export async function askBookConflict(
  conflict: BookConflict, lifecycle: ConflictUiLifecycle,
  show: (conflict: HubPadConflict, lifecycle: ConflictUiLifecycle) => Promise<HubConflictResolution>,
): Promise<BookResolution> {
  const { capture, remote } = conflict;
  const localDisplay=bookDisplay(capture,capture.metadata,capture.record),hubDisplay=bookDisplay(capture,capture.metadata,remote.record);
  const display={...localDisplay,scratchTitles:{...hubDisplay.scratchTitles,...localDisplay.scratchTitles}};
  const primary = conflict.pages.filter(page => page.key === capture.id);
  const scratch = conflict.pages.filter(page => page.key !== capture.id);
  const preview = async (pageId: number) => {
    const page = primary.find(page => page.page_id === pageId);
    if (!page) return { local: null, server: null };
    const local = capture.pages.find(row => row.docKey === localPageKey(capture, page.key) && row.pageId === pageId);
    const prepared = await conflict.loadPage(page);
    const localInk = local ? await encodedFromRecord(local) : null, serverInk = await encodedFromRecord(prepared.row);
    if (!serverInk) throw new Error("The displayed server handwriting cannot be read");
    const kind = capture.kind === "problem" ? "whiteboard" : capture.kind;
    const dto = (gz: string, version: number): InkPageDto => ({ kind, key: page.key, page_id: pageId, updated_at: version, gz });
    return { local: localInk ? dto(bytesToB64(packEncodedInk(localInk)), local!.changeSeq ?? 1) : null,
      server: dto(bytesToB64(packEncodedInk(serverInk)), page.rev) };
  };
  const pad: HubPadConflict = {
    modernChoice: true, fetchPreviewInk: preview,
    kind: capture.kind === "problem" ? "whiteboard" : capture.kind, id: capture.id,
    ...(capture.kind === "problem" ? { wholeCanvas: true } : {}),
    stage: conflict.record || conflict.lifecycle ? "pad" : "ink",
    detail: conflict.lifecycle ? "Choose whether to keep your requested deletion or restoration against this hub version."
      : conflict.pages[0] ? bookConflictMessage(capture, {key:conflict.pages[0].key,pageId:conflict.pages[0].page_id}, display)
        : "Choose the changed record or handwriting pages to keep.",
    local: (capture.kind==="problem"&&capture.record?{...capture.record,title:display.title}:capture.record) as unknown as AnnotatePadDto | WhiteboardPadDto | null,
    server: (capture.kind==="problem"&&remote.record?{...remote.record,title:display.title}:remote.record) as unknown as AnnotatePadDto | WhiteboardPadDto | null,
    localInkPageIds: primary.filter(page => capture.pages.some(row => row.docKey === localPageKey(capture, page.key) && row.pageId === page.page_id)).map(page => page.page_id),
    hubInkPageIds: primary.map(page => page.page_id), serverInk: [],
    localInkStamps: primary.flatMap(page => {
      const row = capture.pages.find(row => row.docKey === localPageKey(capture, page.key) && row.pageId === page.page_id);
      return row ? [{ pageId: page.page_id, updatedAt: row.changeSeq ?? 1 }] : [];
    }),
    hubInkStamps: primary.map(page => ({ pageId: page.page_id, updatedAt: page.rev })),
    footnoteInk: [...new Set(scratch.map(page => page.key.slice(`${capture.id}/fn/`.length)))].map(wbId => {
      const pages = scratch.filter(page => page.key === `${capture.id}/fn/${wbId}`);
      return { wbId, localPageIds: pages.filter(page => capture.pages.some(row => row.docKey === localPageKey(capture, page.key) && row.pageId === page.page_id)).map(page => page.page_id),
        hubPageIds: pages.map(page => page.page_id),
        localPages: pages.flatMap(page => { const row = capture.pages.find(row => row.docKey === localPageKey(capture, page.key) && row.pageId === page.page_id); return row ? [{ pageId: page.page_id, updatedAt: row.changeSeq ?? 1 }] : []; }),
        hubPages: pages.map(page => ({ pageId: page.page_id, updatedAt: page.rev })) };
    }),
  };
  // Show immediately. Preview/source downloads happen through lazy callbacks.
  const choice = await show(pad, lifecycle);
  let recordValue: Record<string, unknown> | undefined;
  if (choice.pick === "merged" && capture.record) {
    recordValue = { ...capture.record,
      agent: mergeAgentMessages(Array.isArray(capture.record.agent) ? capture.record.agent : [], Array.isArray(remote.record?.agent) ? remote.record.agent : []),
      ...(choice.footnotes ? { footnotes: choice.footnotes } : {}) };
    const children = { ...(capture.record.footnote_boards as Record<string, unknown> ?? {}) };
    const serverChildren = remote.record?.footnote_boards as Record<string, unknown> | undefined;
    for (const [oldId, freshId] of Object.entries(choice.boardRemints ?? {})) if (serverChildren?.[oldId]) children[freshId] = serverChildren[oldId];
    recordValue.footnote_boards = children;
  }
  if (capture.kind === "problem" && inkChoiceOf(choice) === "none") {
    recordValue = { ...(recordValue ?? (choice.pick === "server" ? remote.record : capture.record) ?? {}),
      board: { ...((choice.pick === "server" ? remote.record?.board : capture.record?.board) as Record<string, unknown>), inkC: { v: 1, ops: [] } } };
    const chosenBoard = recordValue.board as Record<string, unknown>; delete chosenBoard.ink; delete chosenBoard.inkPages;
  }
  return { ...(conflict.record ? { record: choice.pick, ...(recordValue ? { recordValue } : {}) } : {}),
    ...(choice.artifacts ? { artifacts: choice.artifacts } : {}),
    ...(conflict.lifecycle ? { lifecycle: choice.pick === "server" ? "server" : "local" } : {}),
    ...(choice.pick === "merged" && choice.boardRemints ? { boardRemints: choice.boardRemints } : {}),
    pages: conflict.pages.map(page => {
      const wbId = page.key === capture.id ? null : page.key.slice(`${capture.id}/fn/`.length);
      const picked = wbId ? choice.footnoteInkPages?.find(row => row.wbId === wbId && row.pageId === page.page_id)?.choice
        : choice.inkPages?.find(row => row.pageId === page.page_id)?.choice;
      return { key: page.key, pageId: page.page_id, choice: picked ?? inkChoiceOf(choice) };
    }) };
}
