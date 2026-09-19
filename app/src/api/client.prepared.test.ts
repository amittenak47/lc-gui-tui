import { expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn(async () => ({ status: 200, body: { reply: "ok" } })));
vi.mock("./nativeHttp", async importOriginal => ({ ...await importOriginal<typeof import("./nativeHttp")>(), loadInvoke: async () => invoke }));
import { LcClient } from "./client";
it("passes the persisted wire body unchanged to every native coach command", async () => {
  const client = new LcClient();
  const payload = { task_id: "original", document_hash: "pdf-a", question: "why", page: 4, page_text: "original words", images: ["original-png"] };
  for (const action of ["ask", "review", "viz", "lazy", "draw_review"] as const) {
    expect(await client.runPreparedCoach(action, payload)).toEqual({ reply: "ok" });
    expect(invoke).toHaveBeenLastCalledWith(`lc_coach_${action}`, { body: payload });
  }
});
