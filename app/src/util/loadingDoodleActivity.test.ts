import { expect, it, vi } from "vitest";
import { beginLoadingDoodle, endLoadingDoodle, waitForLoadingDoodleIdle } from "./loadingDoodleActivity";

it("holds teardown until every captured doodle has lifted or unmounted", async () => {
  const first = {}, second = {};
  beginLoadingDoodle(first);
  beginLoadingDoodle(second);
  const done = vi.fn();
  const waiting = waitForLoadingDoodleIdle().then(done);
  endLoadingDoodle(first);
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  endLoadingDoodle(second);
  await waiting;
  expect(done).toHaveBeenCalledOnce();
});
