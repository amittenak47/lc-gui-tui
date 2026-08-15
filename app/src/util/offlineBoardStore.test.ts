import { describe, expect, it } from "vitest";

import { chooseOfflineMerge } from "./offlineBoardStore";

describe("chooseOfflineMerge", () => {
  it("asks when timestamps differ under ask policy", () => {
    expect(chooseOfflineMerge("ask", 10, 20)).toBe("ask");
    expect(chooseOfflineMerge("ask", 20, 10)).toBe("ask");
  });

  it("prefers local or server regardless of which stamp is newer", () => {
    expect(chooseOfflineMerge("prefer-local", 10, 20)).toBe("local");
    expect(chooseOfflineMerge("prefer-server", 20, 10)).toBe("server");
  });

  it("keeps local when the server has no board", () => {
    expect(chooseOfflineMerge("ask", 10, null)).toBe("local");
    expect(chooseOfflineMerge("prefer-server", 10, null)).toBe("local");
  });
});
