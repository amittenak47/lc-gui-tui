import { afterEach, describe, expect, it, vi } from "vitest";

import { checkPadHub } from "./client";

const HUB = { url: "http://192.168.1.10:7878", token: "123456" };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkPadHub", () => {
  it("reports the version when both halves are right", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/health")
          ? reply(200, { ok: true, version: "0.1.0", requires_token: true })
          : reply(200, { serve_port: 7878 }),
      ),
    );
    await expect(checkPadHub(HUB)).resolves.toEqual({ ok: true, version: "0.1.0" });
  });

  it("blames the code, not the network, when the PC refuses it", async () => {
    // `/health` sits outside the token check, so it answers either way. Only
    // the authenticated call separates a wrong code from a wrong address, and
    // telling those apart is the whole point of asking twice.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/health") ? reply(200, { ok: true, version: "0.1.0" }) : reply(401, { error: "missing or invalid token" }),
      ),
    );
    await expect(checkPadHub(HUB)).resolves.toMatchObject({ ok: false, reason: "code" });
  });

  it("blames the address when nothing answers at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const result = await checkPadHub(HUB);
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    // The cause is carried through rather than flattened into "failed": the
    // reader is being asked to go and check something, and which something
    // depends on this.
    expect(result.ok === false && result.detail).toContain("Failed to fetch");
  });

  it("does not ask a wrong-looking hub twice", async () => {
    const fetchMock = vi.fn(async () => reply(503, { error: "down" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkPadHub(HUB)).resolves.toMatchObject({ ok: false, reason: "unreachable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tolerates a trailing slash on the URL someone typed", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return url.endsWith("/health") ? reply(200, { ok: true, version: "9" }) : reply(200, {});
      }),
    );
    await checkPadHub({ ...HUB, url: `${HUB.url}/` });
    expect(seen[0]).toBe("http://192.168.1.10:7878/health");
  });
});
