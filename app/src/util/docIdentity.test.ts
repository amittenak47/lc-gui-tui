/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { docIdentityHash, hashMarkdown } from "./annotateStore";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("docIdentityHash", () => {
  it("gives one web page one identity however often it is frozen", () => {
    /*
     * The bug this exists for: a web pad's text is a frozen copy made moments
     * ago, so hashing it minted a new identity on every freeze — a second row
     * in Recent, a second index, and the previous one orphaned.
     */
    const first = docIdentityHash({
      docType: "web",
      name: "https://substack.com/",
      text: "<html>one capture</html>",
    });
    const second = docIdentityHash({
      docType: "web",
      name: "https://substack.com",
      text: "<html>a completely different capture</html>",
    });
    expect(first).toBe(second);
  });

  it("keeps two different pages apart", () => {
    const a = docIdentityHash({ docType: "web", name: "https://a.com", text: "x" });
    const b = docIdentityHash({ docType: "web", name: "https://b.com", text: "x" });
    expect(a).not.toBe(b);
  });

  it("still identifies a markdown note by its text", () => {
    const same = docIdentityHash({ docType: "markdown", name: "n.md", text: "# Title" });
    expect(same).toBe(hashMarkdown("# Title"));
    const other = docIdentityHash({ docType: "markdown", name: "n.md", text: "# Other" });
    expect(same).not.toBe(other);
  });

  it("identifies code by its text, not its filename", () => {
    const a = docIdentityHash({ docType: "code", name: "a.ts", text: "const x = 1;" });
    const b = docIdentityHash({ docType: "code", name: "b.ts", text: "const x = 1;" });
    expect(a).toBe(b);
  });

  it("falls back to the text when a web name is not an address", () => {
    const hash = docIdentityHash({ docType: "web", name: "not a url", text: "<p>hi</p>" });
    expect(hash).toBe(hashMarkdown("<p>hi</p>"));
  });
});
