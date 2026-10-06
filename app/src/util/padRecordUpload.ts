import type { AnnotatePadDto, InkPageDigestDto, LcClient, WhiteboardPadDto } from "../api/client";
import type { BoardBlob } from "../canvas/BoardHandle";

/** Every record writer uses this gate, including queued writes and restores. */
export async function putPadRecord(
  client: LcClient,
  kind: "annotate" | "whiteboard",
  body: AnnotatePadDto | WhiteboardPadDto,
  digests?: InkPageDigestDto[],
): Promise<AnnotatePadDto | WhiteboardPadDto> {
  const manifests = [{ key: body.id, board: body.board as BoardBlob | undefined }];
  if (kind === "annotate") {
    for (const [wbId, entry] of Object.entries((body as AnnotatePadDto).footnote_boards ?? {})) {
      manifests.push({ key: `${body.id}/fn/${wbId}`, board: entry.board as BoardBlob });
    }
  }
  const pads = manifests.filter(({ board }) => board?.inkPages?.pageIds.length);
  if (pads.length) {
    const { ensureRecordInkOnHub } = await import("./inkSync");
    await ensureRecordInkOnHub(client, kind, pads.map(({ key, board }) => ({
      key, pageIds: board!.inkPages!.pageIds,
    })), digests, body.sync_seq);
  }
  return kind === "annotate"
    ? client.putAnnotatePad(body.id, body as AnnotatePadDto)
    : client.putWhiteboardPad(body.id, body as WhiteboardPadDto);
}
