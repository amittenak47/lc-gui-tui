import type { LcClient } from "../api/client";
import { deleteProblemBoard, problemPadId } from "./problemBoardStore";

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
    // The durable current deletion intent survives closing and a hub outage.
    await deleteProblemBoard(id);
  }
  await dismiss();
  run();
}
