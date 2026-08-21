import { describe, expect, it } from "vitest";

import { webIdentityUrl } from "./webIdentity";

describe("webIdentityUrl", () => {
  it("is stable across re-freezes of one address", () => {
    // The whole point: freezing substack.com twice must be one pad, not two.
    expect(webIdentityUrl("https://substack.com/")).toBe(
      webIdentityUrl("https://substack.com"),
    );
  });

  it("drops the fragment — a place on a page is not another page", () => {
    expect(webIdentityUrl("https://example.com/post#intro")).toBe(
      webIdentityUrl("https://example.com/post"),
    );
  });

  it("keeps the query — that usually *is* another page", () => {
    expect(webIdentityUrl("https://example.com/p?id=5")).not.toBe(
      webIdentityUrl("https://example.com/p?id=6"),
    );
  });

  it("normalises host case but not path case", () => {
    expect(webIdentityUrl("https://Example.COM/Post")).toBe("https://example.com/Post");
  });

  it("assumes https when no scheme was typed", () => {
    expect(webIdentityUrl("substack.com")).toBe("https://substack.com");
  });

  it("keeps a trailing slash on a deeper path", () => {
    // A server may well treat /a and /a/ as different things; only the bare
    // root is normalised, where every server agrees.
    expect(webIdentityUrl("https://example.com/a/")).not.toBe(
      webIdentityUrl("https://example.com/a"),
    );
  });

  it("refuses what is not an http address", () => {
    expect(webIdentityUrl("")).toBeNull();
    expect(webIdentityUrl("   ")).toBeNull();
    expect(webIdentityUrl("javascript:alert(1)")).toBeNull();
    expect(webIdentityUrl("file:///etc/passwd")).toBeNull();
  });
});
