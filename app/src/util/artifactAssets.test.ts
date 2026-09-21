import { describe, expect, it } from "vitest";
import { packEncodedInk } from "../canvas/inkCodec";
import { bytesToB64 } from "../api/nativeHttp";
import { artifactAssetKey, parseArtifactAsset, requireArtifactAssetAck, type ArtifactAsset } from "./artifactAssets";

const board = { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const scene: ArtifactAsset = {
  parent: { kind: "annotate", id: "a1" }, dependency: { kind: "scene", id: "b1", revision: "r1" },
  payload: JSON.stringify({ v: 1, board, pageCount: 1, programs: [] }),
};
const packed = bytesToB64(packEncodedInk({ v: 2, ops: [] }));

describe("attachment transfer payloads", () => {
  it("preserves exact payload bytes and parent-scoped revision identities", () => {
    expect(parseArtifactAsset(scene)).toEqual(scene);
    expect(artifactAssetKey(scene)).not.toBe(artifactAssetKey({ ...scene, parent: { ...scene.parent, id: "a2" } }));
    expect(() => requireArtifactAssetAck(scene, scene)).not.toThrow();
    expect(() => requireArtifactAssetAck(scene, { ...scene, payload: `${scene.payload} ` })).toThrow("not acknowledged");
  });

  it("rejects inline typed-array ink and malformed scenes", () => {
    expect(() => parseArtifactAsset({ ...scene, payload: JSON.stringify({ v: 1, board: {}, pageCount: 1, programs: [] }) })).toThrow();
    expect(() => parseArtifactAsset({ ...scene, payload: JSON.stringify({
      v: 1, board: { ...board, inkC: { v: 2, ops: [] } }, pageCount: 1, programs: [],
    }) })).toThrow();
  });

  it("decodes packed ink before accepting its revision, including page zero", () => {
    const ink = { ...scene, dependency: { kind: "ink" as const, id: "b1", revision: "i1", pageId: 0 },
      payload: JSON.stringify({ v: 1, packed }) };
    expect(parseArtifactAsset(ink)).toEqual(ink);
    expect(() => parseArtifactAsset({ ...ink, payload: JSON.stringify({ v: 1, packed: "AA==" }) })).toThrow();
    const bytes = packEncodedInk({ v: 2, ops: [] });
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => parseArtifactAsset({ ...ink, payload: JSON.stringify({ v: 1, packed: bytesToB64(trailing) }) })).toThrow();
    const metadata = new TextEncoder().encode(JSON.stringify({ meta: [{ xyN: 1000000000, prN: 0, slN: 0, rrN: 0 }] }));
    const truncated = new Uint8Array(12 + metadata.length);
    truncated.set(bytes.subarray(0, 8));
    new DataView(truncated.buffer).setUint32(8, metadata.length, true);
    truncated.set(metadata, 12);
    expect(() => parseArtifactAsset({ ...ink, payload: JSON.stringify({ v: 1, packed: bytesToB64(truncated) }) })).toThrow();
  });

  it("requires owned text documents and their complete ink manifest", () => {
    const payload = { v: 1, owned: true, docType: "code", name: "example.py", source: "print(1)",
      board: { ...board, inkPages: { v: 1, pageIds: [1] } }, footnotes: [], agent: [], ink: [{ pageId: 1, packed }] };
    const doc = { ...scene, dependency: { kind: "document" as const, id: "d1", revision: "s1" }, payload: JSON.stringify(payload) };
    expect(parseArtifactAsset(doc)).toEqual(doc);
    expect(() => parseArtifactAsset({ ...doc, payload: JSON.stringify({ ...payload, ink: [] }) })).toThrow();
    expect(() => parseArtifactAsset({ ...doc, payload: JSON.stringify({ ...payload, owned: false }) })).toThrow();
  });
});
