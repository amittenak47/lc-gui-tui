/**
 * Off-thread concat + gzip for ink shards.
 *
 * Snapshot assemble and dirty→archive drain must not run under the pen.
 * Main thread only postMessages; failed pages stay dirty and are skipped.
 */

import {
  concatEncodedInk,
  packEncodedInk,
  unpackEncodedInk,
  type EncodedInk,
} from "./inkCodec";
import { bytesFromMaybeGzip, gzipBytes } from "../util/gzip";

export type InkArchiveRequest =
  | { id: number; type: "concat"; shards: EncodedInk[] }
  | { id: number; type: "gzipPack"; encoded: EncodedInk }
  | { id: number; type: "gunzipUnpack"; bytes: Uint8Array<ArrayBuffer> }
  | { id: number; type: "concatAndGzip"; shards: EncodedInk[] };

export type InkArchiveResponse =
  | { id: number; ok: true; encoded?: EncodedInk; bytes?: Uint8Array<ArrayBuffer> }
  | { id: number; ok: false; error: string };

async function handle(msg: InkArchiveRequest): Promise<InkArchiveResponse> {
  try {
    if (msg.type === "concat") {
      return { id: msg.id, ok: true, encoded: concatEncodedInk(msg.shards) };
    }
    if (msg.type === "gzipPack") {
      const packed = packEncodedInk(msg.encoded);
      return { id: msg.id, ok: true, bytes: await gzipBytes(packed) };
    }
    if (msg.type === "gunzipUnpack") {
      const raw = await bytesFromMaybeGzip(msg.bytes);
      const encoded = unpackEncodedInk(raw);
      if (!encoded) return { id: msg.id, ok: false, error: "could not unpack ink archive" };
      return { id: msg.id, ok: true, encoded };
    }
    const encoded = concatEncodedInk(msg.shards);
    const bytes = await gzipBytes(packEncodedInk(encoded));
    return { id: msg.id, ok: true, encoded, bytes };
  } catch (cause) {
    return { id: msg.id, ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

self.onmessage = (event: MessageEvent<InkArchiveRequest>) => {
  void handle(event.data).then((response) => {
    (self as unknown as Worker).postMessage(response);
  });
};
