import { describe, expect, it } from "vitest";
import { CoachSendCoordinator } from "./coachSendCoordinator";
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
describe("coach send ordering and transport ownership", () => {
  it("disposing a blocked preparation cannot start the next queued request", () => {
    const seen: string[] = [];
    const q = new CoachSendCoordinator<string>(async value => { seen.push(value); }, () => {});
    q.reserve("a"); q.reserve("b"); q.ready("b", "b"); q.dispose();
    expect(seen).toEqual([]); expect(q.tickets.get("b")?.state).toBe("cancelled");
  });
  it("reserves before preparation and waits for transport release after abort", async () => {
    const seen: string[] = []; const releases: Array<() => void> = [];
    const q = new CoachSendCoordinator<string>(value => { seen.push(value); return new Promise(r => releases.push(r)); }, () => {});
    q.reserve("a"); q.reserve("b"); q.ready("b", "second");
    expect(seen).toEqual([]);
    q.ready("a", "first"); q.abort("a");
    expect(seen).toEqual(["first"]);
    releases.shift()!(); await tick();
    expect(seen).toEqual(["first", "second"]);
    expect(q.tickets.get("a")?.state).toBe("cancelled");
    releases.shift()!(); await tick(); expect(q.runningId).toBeNull();
  });
  it("editing a later ticket pauses the entire waiting queue", async () => {
    const seen: string[] = []; let release!: () => void;
    const q = new CoachSendCoordinator<string>(async value => { seen.push(value); if (value === "a") await new Promise<void>(r => release = r); }, () => {});
    for (const id of ["a", "b", "c"]) { q.reserve(id); q.ready(id, id); }
    expect(q.beginEdit("c")).toBe(true);
    release(); await tick(); expect(seen).toEqual(["a"]);
    q.endEdit("c", "edited"); await tick(); await tick();
    expect(seen).toEqual(["a", "b", "edited"]);
  });
  it("failed and cancelled preparations cannot strand later messages", async () => {
    const seen: string[] = [];
    const q = new CoachSendCoordinator<string>(async value => { seen.push(value); }, () => {});
    q.reserve("a"); q.reserve("b"); q.reserve("c"); q.ready("c", "c");
    q.abort("a"); q.ready("a", "late"); q.fail("b", "capture failed"); await tick();
    expect(seen).toEqual(["c"]);
  });
});
