import { beforeEach, expect, it, vi } from "vitest";
import { createTauriCoachSocket } from "./coachSocket";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.listen.mockReset().mockResolvedValue(vi.fn());
});

it("isolates event subscriptions, sends, and disconnects by socket", async () => {
  const first = createTauriCoachSocket("");
  const second = createTauriCoachSocket("");
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "lc_coach_connect")).toHaveLength(2));
  const connections = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "lc_coach_connect");
  const firstId = connections[0][1].channelId;
  const secondId = connections[1][1].channelId;
  expect(firstId).not.toBe(secondId);
  expect(firstId).toMatch(/^[a-zA-Z0-9-]+$/);
  expect(mocks.listen).toHaveBeenCalledWith(`lc-coach-frame-${firstId}`, expect.any(Function));
  first.send("hello"); first.close(); second.send("still connected");
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("lc_coach_send", { channelId: secondId, frame: "still connected" }));
  expect(mocks.invoke).toHaveBeenCalledWith("lc_coach_disconnect", { channelId: firstId });
  expect(mocks.invoke).not.toHaveBeenCalledWith("lc_coach_disconnect", { channelId: secondId });
  second.close();
});

it("closes immediately but disconnects after an in-flight native connect resolves", async () => {
  let finish!: () => void;
  mocks.invoke.mockImplementation((command: string) => command === "lc_coach_connect"
    ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve());
  const socket = createTauriCoachSocket("");
  const opened = vi.fn(); const closed = vi.fn();
  socket.onopen = opened; socket.onclose = closed;
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  socket.close(); expect(closed).toHaveBeenCalledOnce();
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "lc_coach_disconnect")).toBe(false);
  finish();
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "lc_coach_disconnect")).toBe(true));
  expect(opened).not.toHaveBeenCalled();
});

it("reports failed native connection and closes the transport", async () => {
  mocks.invoke.mockRejectedValue(new Error("unavailable"));
  const socket = createTauriCoachSocket("");
  socket.onerror = vi.fn(); socket.onclose = vi.fn();
  await vi.waitFor(() => expect(socket.onclose).toHaveBeenCalledOnce());
  expect(socket.onerror).toHaveBeenCalledOnce();
});
