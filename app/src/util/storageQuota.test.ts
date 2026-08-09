/** @vitest-environment jsdom */

/**
 * The part worth pinning is the classification: a quota failure has to be
 * distinguishable from every other reason a write can fail, or the banner ends
 * up blaming a full device for a bug.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatBytes,
  isQuotaError,
  setStorageItem,
  StorageFullError,
} from "./storageQuota";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A DOMException is not constructible with an arbitrary `code` — fake the shape. */
function quotaError(name: string, code: number): unknown {
  return Object.assign(new Error(name), { name, code });
}

describe("isQuotaError", () => {
  it("recognises the Chrome and Safari spelling", () => {
    expect(isQuotaError(quotaError("QuotaExceededError", 22))).toBe(true);
  });

  it("recognises the Firefox spelling", () => {
    expect(isQuotaError(quotaError("NS_ERROR_DOM_QUOTA_REACHED", 1014))).toBe(true);
  });

  it("recognises an older WebKit failure that only carries the code", () => {
    expect(isQuotaError(Object.assign(new Error("full"), { code: 22 }))).toBe(true);
  });

  it("does not claim an ordinary error", () => {
    expect(isQuotaError(new TypeError("cyclic structure"))).toBe(false);
  });

  it("survives a thrown non-object", () => {
    expect(isQuotaError("nope")).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});

describe("setStorageItem", () => {
  it("writes through when there is room", () => {
    setStorageItem("lc.test.key", "value");
    expect(localStorage.getItem("lc.test.key")).toBe("value");
  });

  it("turns a quota failure into a StorageFullError", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw quotaError("QuotaExceededError", 22);
    });
    expect(() => setStorageItem("lc.test.key", "value")).toThrow(StorageFullError);
  });

  it("rethrows anything that is not the quota untouched", () => {
    // A store disabled by browser policy, or a serialisation that threw, is a
    // different problem — reporting it as a full device would send someone off
    // deleting documents that were never the cause.
    const other = new TypeError("localStorage is disabled");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw other;
    });
    expect(() => setStorageItem("lc.test.key", "value")).toThrow(other);
  });

  it("keeps the original failure as the cause", () => {
    const raw = quotaError("QuotaExceededError", 22);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw raw;
    });
    try {
      setStorageItem("lc.test.key", "value");
      expect.unreachable("should have thrown");
    } catch (cause) {
      expect(cause).toBeInstanceOf(StorageFullError);
      expect((cause as StorageFullError).cause).toBe(raw);
    }
  });
});

describe("formatBytes", () => {
  it("reads in MB below a gigabyte", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("drops the decimal once the number is big enough not to need it", () => {
    expect(formatBytes(120 * 1024 * 1024)).toBe("120 MB");
  });

  it("switches to GB", () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });

  it("does not render a rounding artefact for a nearly-empty store", () => {
    expect(formatBytes(1024)).toBe("<0.1 MB");
  });

  it("survives nonsense", () => {
    expect(formatBytes(Number.NaN)).toBe("0 MB");
    expect(formatBytes(-1)).toBe("0 MB");
  });
});
