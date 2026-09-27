import type { InkPageDto } from "../api/client";
import { b64ToBytes } from "../api/nativeHttp";
import { gunzipUnpackInk } from "../canvas/inkArchiveClient";
import { decodeInkOpsAsync } from "../canvas/inkCodec";
import { inkOpsEqual, type ConflictInkDecodeCache } from "./conflictInkLayout";

/** Exact content comparison. Unreadable/missing data must stay a visible choice. */
export async function compareConflictInk(local?: InkPageDto, server?: InkPageDto, cache?: ConflictInkDecodeCache): Promise<boolean | null> {
  if (!local?.gz || !server?.gz) return null;
  if (local.gz === server.gz) return true;
  try {
    // Visible/legacy spanning ink may already be decoding for the preview.
    // Join that work instead of allocating another full pair of stroke arrays.
    if (cache?.has(local.gz) && cache.has(server.gz)) {
      const [left,right] = await Promise.all([cache.get(local.gz),cache.get(server.gz)]);
      return left && right ? inkOpsEqual(left,right) : null;
    }
    const left = await gunzipUnpackInk(b64ToBytes(local.gz));
    const right = await gunzipUnpackInk(b64ToBytes(server.gz));
    if (!left || !right) return null;
    return inkOpsEqual(await decodeInkOpsAsync(left), await decodeInkOpsAsync(right));
  } catch { return null; }
}

/**
 * Whether a stored page holds a single pen stroke.
 *
 * A page can keep a stored copy after its last stroke was undone, or hold
 * only eraser passes. Both sides agreeing on nothing is not a choice worth a
 * row. Null when the page cannot be read — that stays visible.
 */
export async function inkPageHasStrokes(page?: InkPageDto, cache?: ConflictInkDecodeCache): Promise<boolean | null> {
  if (!page?.gz) return null;
  try {
    const cached = cache?.get(page.gz);
    const ops = cached
      ? await cached
      : await (async () => {
          const encoded = await gunzipUnpackInk(b64ToBytes(page.gz));
          return encoded ? decodeInkOpsAsync(encoded) : null;
        })();
    return ops ? ops.some((op) => op.kind === "draw") : null;
  } catch {
    return null;
  }
}
