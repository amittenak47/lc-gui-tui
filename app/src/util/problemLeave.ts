import type { LcClient } from "../api/client";
import { enqueuePadSync, flushPadSyncQueue } from "./padSync";
import { deleteProblemBoard, getProblemBoard, problemPadId } from "./problemBoardStore";

/** Finish local work before closing; a hub outage must never hold the tab open. */
export async function resolveProblemLeave(options: {
  client: LcClient;
  dataset: string;
  taskId: string;
  agent: unknown[];
  solved: boolean;
  save: boolean;
  localSaves: Promise<unknown>[];
  dismiss: () => Promise<void>;
  run: () => void;
}): Promise<void> {
  const { client, dataset, taskId, agent, solved, save, localSaves, dismiss, run } = options;
  if (agent.length) {
    await client.putAgentSession(taskId, agent, dataset).catch(() => {});
  }
  await Promise.all(localSaves);
  const outcome = await client.finishAttempt(taskId, { solved, save }, dataset);
  if (!outcome.kept_layout) {
    const id = problemPadId(dataset, taskId);
    const row = await getProblemBoard(id);
    // Persist before contacting the hub, including when it never answers.
    await enqueuePadSync(
      { op: "deletePad", kind: "problem", padId: id, seq: (row?.syncSeq ?? 0) + 1 },
      { requirePersistence: true },
    );
    await deleteProblemBoard(id);
  }
  await dismiss();
  run();
  // The queue owns retry and acknowledgement. It also survives this workspace.
  void flushPadSyncQueue(client).catch(() => {});
}
