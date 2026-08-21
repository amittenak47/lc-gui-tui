import { describe, expect, it } from "vitest";

import { messageOf } from "./messageOf";

describe("messageOf", () => {
  it("uses an Error's message", () => {
    expect(messageOf(new Error("no such tab"))).toBe("no such tab");
  });

  it("passes a thrown string through", () => {
    expect(messageOf("state not managed")).toBe("state not managed");
  });

  it("never renders an object as [object Object]", () => {
    // The banner said exactly this when the browser failed to open, which is
    // the whole reason this function is not `String(cause)`.
    expect(messageOf({ code: -32603 })).not.toContain("[object Object]");
  });

  it("prefers a message field on an error-shaped object", () => {
    expect(messageOf({ message: "webview not found", code: 4 })).toBe("webview not found");
  });

  it("looks one level into a nested error", () => {
    expect(messageOf({ error: { message: "bad token" } })).toBe("bad token");
  });

  it("falls back to JSON so the payload is still evidence", () => {
    expect(messageOf({ code: -32603 })).toBe('{"code":-32603}');
  });

  it("skips empty strings rather than reporting nothing", () => {
    expect(messageOf({ message: "  ", detail: "disk full" })).toBe("disk full");
  });

  it("survives a circular object", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(messageOf(loop)).toBe("unknown error");
  });

  it("names null and undefined rather than printing them", () => {
    expect(messageOf(null)).toBe("unknown error");
    expect(messageOf(undefined)).toBe("unknown error");
  });

  it("still handles primitives", () => {
    expect(messageOf(404)).toBe("404");
  });

  it("falls back to the name when an Error has no message", () => {
    expect(messageOf(new TypeError())).toBe("TypeError");
  });
});
