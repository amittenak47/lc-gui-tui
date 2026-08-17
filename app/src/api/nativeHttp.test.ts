import { describe, expect, it } from "vitest";

import { isLcInvokeResponse, readInvokeResult } from "./nativeHttp";

describe("readInvokeResult", () => {
  it("unwraps router { status, body } envelopes", () => {
    expect(
      readInvokeResult({ status: 200, body: [{ slug: "leetcode" }] }),
    ).toEqual({
      status: 200,
      body: [{ slug: "leetcode" }],
    });
  });

  it("keeps HTTP error status so the client can throw", () => {
    expect(readInvokeResult({ status: 404, body: { error: "gone" } })).toEqual({
      status: 404,
      body: { error: "gone" },
    });
  });

  it("treats a raw array as the body — DLC used to return Vec, not an envelope", () => {
    const rows = [{ slug: "leetcode", count: 0 }];
    expect(isLcInvokeResponse(rows)).toBe(false);
    expect(readInvokeResult(rows)).toEqual({ status: 200, body: rows });
  });

  it("treats a raw object without status as the body", () => {
    const row = { slug: "leetcode", phase: "idle", count: 0 };
    expect(isLcInvokeResponse(row)).toBe(false);
    expect(readInvokeResult(row)).toEqual({ status: 200, body: row });
  });
});
