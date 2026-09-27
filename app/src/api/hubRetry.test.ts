import { afterEach, expect, it, vi } from "vitest";
import { fetchWithNetworkRetry } from "./client";

afterEach(() => vi.unstubAllGlobals());

const ok = () => new Response("{}", { status: 200 });

it("retries a read that failed before any answer, and returns the answer", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(ok());
  vi.stubGlobal("fetch", fetch);
  const res = await fetchWithNetworkRetry("http://hub/pads/sync", { method: "GET" }, [0, 0]);
  expect(res.status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("gives up after the last retry", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  vi.stubGlobal("fetch", fetch);
  await expect(fetchWithNetworkRetry("http://hub/x", { method: "GET" }, [0, 0])).rejects.toThrow("Failed to fetch");
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("never sends a write twice", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  vi.stubGlobal("fetch", fetch);
  await expect(fetchWithNetworkRetry("http://hub/x", { method: "PUT" }, [0, 0])).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("treats an HTTP error as an answer, not a failure to reach", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("no", { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  const res = await fetchWithNetworkRetry("http://hub/x", { method: "GET" }, [0, 0]);
  expect(res.status).toBe(503);
  expect(fetch).toHaveBeenCalledTimes(1);
});
