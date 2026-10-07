import { expect, it } from "vitest";
import { bookWireRecord } from "./bookWireRecord";
import { canonicalJson } from "./syncContent";

it("omits only defined optional transcript and footnote DTO fields that are undefined", () => {
  const original = { agent: [{ id: "turn", queued: undefined, deletedAt: 123, future: { source: "kept" } }],
    footnotes: [{ id: "mark", notes: undefined, threads: [], threadRootId: undefined, future: { kept: true } }] };
  const wire = bookWireRecord(original);
  expect(wire).toStrictEqual({ agent: [{ id: "turn", deletedAt: 123, future: { source: "kept" } }], footnotes: [{ id: "mark", threads: [], future: { kept: true } }] });
  expect(Object.hasOwn(original.footnotes[0]!, "notes")).toBe(true);
  expect(() => canonicalJson(wire)).not.toThrow();
});
it("keeps unknown user fields for validation, including nested unrepresentable values", () => {
  expect(() => canonicalJson(bookWireRecord({ agent: [{ future: undefined }] }))).toThrow("unsupported JSON value");
  expect(() => canonicalJson(bookWireRecord({ author: { queued: undefined } }))).toThrow("unsupported JSON value");
});
it("keeps all defined optional authored data, zero timestamps, empty lists and tombstones", () => {
  const record = { agent: [{ id: "turn", deletedAt: 0, queued: false, attachments: [] }], footnotes: [{ notes: [], updatedAt: 0, png: "", threadRootId: "turn" }] };
  expect(bookWireRecord(record)).toStrictEqual(record);
});
