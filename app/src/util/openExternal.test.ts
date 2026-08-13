import { describe, expect, it } from "vitest";

import { isSafeExternalUrl, normalizeExternalUrl } from "./openExternal";

describe("normalizeExternalUrl", () => {
  it("adds https when the scheme is missing", () => {
    expect(normalizeExternalUrl("example.com")).toBe("https://example.com");
    expect(normalizeExternalUrl("  example.com/path  ")).toBe("https://example.com/path");
  });

  it("keeps http(s) URLs", () => {
    expect(normalizeExternalUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeExternalUrl("http://example.com")).toBe("http://example.com");
  });

  it("rejects empty and non-http schemes", () => {
    expect(normalizeExternalUrl("")).toBeNull();
    expect(normalizeExternalUrl("   ")).toBeNull();
    expect(normalizeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeExternalUrl("mailto:a@b.c")).toBeNull();
  });
});

describe("isSafeExternalUrl", () => {
  it("allows only http(s)", () => {
    expect(isSafeExternalUrl("https://example.com")).toBe(true);
    expect(isSafeExternalUrl("example.com")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });
});
