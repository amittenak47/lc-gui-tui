import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("./nativeHttp", async original => ({ ...await original<typeof import("./nativeHttp")>(), loadInvoke: async () => invoke }));
vi.mock("../util/padHub", async original => ({ ...await original<typeof import("../util/padHub")>(), loadPadHub: () => null }));
import { LcClient, type PadSnapshotDto } from "./client";
const body: PadSnapshotDto = { kind: "annotate", key: "a1", tier: "24h", written_at: 10,
  payload: { artifactBundle: { v: 1, catalog: { v: 1, parent: { kind: "annotate", id: "a1" }, revision: "c1", artifacts: [] }, assets: [] } } };
beforeEach(() => invoke.mockReset());

it("requires the hub to echo a preserved attachment backup after PUT", async () => {
  invoke.mockImplementation(async (command: string) => ({ status: 200,
    body: command === "lc_get_snapshots" ? [body] : { applied: true } }));
  await new LcClient().putPadSnapshot(body);
  expect(invoke).toHaveBeenCalledWith("lc_put_snapshot", { body });
  expect(invoke).toHaveBeenCalledWith("lc_get_snapshots", { kind: "annotate", key: "a1" });
});
it("rejects a successful status when the hub discarded the attachment field", async () => {
  invoke.mockImplementation(async (command: string) => ({ status: 200,
    body: command === "lc_get_snapshots" ? [{ ...body, payload: {} }] : { applied: true } }));
  await expect(new LcClient().putPadSnapshot(body)).rejects.toThrow("not acknowledged");
});
it("keeps legacy snapshot PUTs compatible without the extra readback", async () => {
  invoke.mockResolvedValue({ status: 200, body: { applied: true } });
  await new LcClient().putPadSnapshot({ ...body, payload: {} });
  expect(invoke).toHaveBeenCalledTimes(1);
});
