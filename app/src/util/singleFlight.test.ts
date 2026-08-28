import { describe, expect, it } from "vitest";

import { singleFlight } from "./singleFlight";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("singleFlight", () => {
  it("runs once for callers that overlap", async () => {
    let runs = 0;
    const gate = deferred<number>();
    const probe = singleFlight(() => {
      runs += 1;
      return gate.promise;
    });

    const a = probe();
    const b = probe();
    const c = probe();
    expect(runs).toBe(1);

    gate.resolve(7);
    expect(await Promise.all([a, b, c])).toEqual([7, 7, 7]);
  });

  it("runs again once the first has settled", async () => {
    let runs = 0;
    const probe = singleFlight(async () => {
      runs += 1;
      return runs;
    });

    expect(await probe()).toBe(1);
    expect(await probe()).toBe(2);
    expect(runs).toBe(2);
  });

  it("shares a rejection and then frees the slot", async () => {
    let runs = 0;
    const gate = deferred<number>();
    const probe = singleFlight(() => {
      runs += 1;
      return runs === 1 ? gate.promise : Promise.resolve(99);
    });

    const a = probe();
    const b = probe();
    gate.reject(new Error("no daemon"));

    await expect(a).rejects.toThrow("no daemon");
    await expect(b).rejects.toThrow("no daemon");
    expect(runs).toBe(1);

    // A failed probe must not wedge the poller shut.
    expect(await probe()).toBe(99);
    expect(runs).toBe(2);
  });

  it("lets a caller start the next run from its own handler", async () => {
    let runs = 0;
    const probe = singleFlight(async () => {
      runs += 1;
      return runs;
    });

    const chained = await probe().then(() => probe());
    expect(chained).toBe(2);
    expect(runs).toBe(2);
  });
});
