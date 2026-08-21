import { beforeEach, describe, expect, it } from "vitest";

import { queued, resetLabelQueues } from "./labelQueue";

beforeEach(() => {
  resetLabelQueues();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("queued", () => {
  it("does not start the second job until the first settles", async () => {
    const gate = deferred<void>();
    const order: string[] = [];
    const first = queued("live", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = queued("live", async () => {
      order.push("second:start");
    });
    await Promise.resolve();
    // This is the whole point: the close and the open cannot be in flight
    // together, which is what produced "already exists".
    expect(order).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("keeps going after a failure rather than wedging the name", async () => {
    await expect(
      queued("live", async () => {
        throw new Error("could not open");
      }),
    ).rejects.toThrow("could not open");
    await expect(queued("live", async () => "ok")).resolves.toBe("ok");
  });

  it("keeps separate names independent", async () => {
    const gate = deferred<void>();
    const slow = queued("capture", async () => {
      await gate.promise;
      return "capture";
    });
    // A stuck offscreen render must not hold up the page you are looking at.
    await expect(queued("live", async () => "live")).resolves.toBe("live");
    gate.resolve();
    await expect(slow).resolves.toBe("capture");
  });

  it("returns each caller its own result", async () => {
    const a = queued("live", async () => 1);
    const b = queued("live", async () => 2);
    expect(await Promise.all([a, b])).toEqual([1, 2]);
  });
});
