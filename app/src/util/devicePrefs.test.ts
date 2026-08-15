/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevicePrefsDto, LcClient } from "../api/client";
import {
  collectDevicePrefsBlob,
  ensureDevicePrefs,
  loadDeviceId,
  resetDevicePrefsCloneForTests,
} from "./devicePrefs";

function fakeClient(overrides: Partial<LcClient> = {}): LcClient {
  return {
    getDevicePrefs: vi.fn(async () => null),
    cloneDevicePrefs: vi.fn(async () => null),
    putDevicePrefs: vi.fn(async (_id: string, body: unknown) => body),
    listDevices: vi.fn(async () => []),
    ...overrides,
  } as unknown as LcClient;
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0)" });
  resetDevicePrefsCloneForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureDevicePrefs", () => {
  it("clones tablet prefs onto an empty desktop once", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const tablet = {
      id: "tab",
      role: "android",
      prefs: { handedness: "left", themeId: "parchment" },
      updated_at: 1,
    };
    const cloneDevicePrefs = vi.fn(async (id: string) => ({
      id,
      role: "desktop",
      prefs: tablet.prefs,
      updated_at: 2,
    }));
    const client = fakeClient({ cloneDevicePrefs });
    const first = await ensureDevicePrefs(client);
    expect(cloneDevicePrefs).toHaveBeenCalled();
    expect(first?.prefs).toEqual(tablet.prefs);

    const secondClient = fakeClient({
      getDevicePrefs: vi.fn(async () => ({
        id: loadDeviceId(),
        role: "desktop",
        prefs: { handedness: "right" },
        updated_at: 3,
      })),
      cloneDevicePrefs,
    });
    await ensureDevicePrefs(secondClient);
    expect(cloneDevicePrefs).toHaveBeenCalledTimes(1);
  });

  it("later tablet save does not clobber the desktop blob", async () => {
    const desk = {
      id: "desk",
      role: "desktop",
      prefs: { handedness: "left" },
      updated_at: 2,
    };
    const putDevicePrefs = vi.fn(async (_id: string, body: DevicePrefsDto) => body);
    const tabletClient = fakeClient({
      getDevicePrefs: vi.fn(async () => null),
      putDevicePrefs,
    });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14)" });
    await ensureDevicePrefs(tabletClient);
    expect(putDevicePrefs.mock.calls[0]?.[0]).not.toBe(desk.id);
    expect(putDevicePrefs.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ role: "android" }),
    );
  });
});

describe("collectDevicePrefsBlob", () => {
  it("includes themeId", () => {
    expect(collectDevicePrefsBlob()).toEqual(expect.objectContaining({ themeId: expect.any(String) }));
  });
});
