/**
 * Stable per-device id and the Personalise blob stored on the harness.
 */

import type { DevicePrefsDto, LcClient } from "../api/client";
import { loadTestForwardMode, saveTestForwardMode } from "./agentPrefs";
import { loadAutosaveBanner, loadAutosaveInterval, saveAutosaveBanner, saveAutosaveInterval } from "./autosavePref";
import {
  loadCaptureCountdown,
  loadCaptureDestination,
  loadCaptureFolder,
  loadCaptureMode,
  saveCaptureCountdown,
  saveCaptureDestination,
  saveCaptureFolder,
  saveCaptureMode,
} from "./capturePrefs";
import {
  loadChromeWakeMarker,
  loadChromeWakeTint,
  saveChromeWakeMarker,
  saveChromeWakeTint,
} from "./chromeWakePref";
import { loadEraserPartial, saveEraserPartial } from "./eraserPartialPref";
import { loadInkHandedness, saveInkHandedness, type InkHandedness } from "./inkHandedness";
import { loadInkBoldness, saveInkBoldness } from "./inkBoldnessPref";
import { loadInkPressureClip, saveInkPressureClip } from "./inkPressureClip";
import {
  loadInkSmoothing,
  loadInkSmoothingMode,
  saveInkSmoothing,
  saveInkSmoothingMode,
} from "./inkSmoothingPref";
import {
  loadInkSpeed,
  loadInkSpeedBlotBlend,
  loadInkSpeedFade,
  loadInkSpeedBodyAccent,
  saveInkSpeed,
  saveInkSpeedBlotBlend,
  saveInkSpeedFade,
  saveInkSpeedBodyAccent,
} from "./inkSpeedPref";
import { loadInkToolPresets, saveInkToolPresets } from "./inkToolPresets";
import { loadOfflineMergePolicy, saveOfflineMergePolicy } from "./offlineMerge";
import { loadPaletteTag, savePaletteTag } from "./palettePref";
import { applyAppTheme, loadThemeId, saveThemeId } from "../theme/appThemes";

const DEVICE_ID_KEY = "whiteboard.deviceId.v1";
const CLONED_KEY = "whiteboard.devicePrefsCloned.v1";

export type DeviceRole = "android" | "desktop" | "browser";

export function loadDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && existing.trim()) return existing;
  } catch {
    /* private browsing */
  }
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    localStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}

export function deviceRole(): DeviceRole {
  if (typeof navigator === "undefined") return "browser";
  const ua = navigator.userAgent || "";
  if (/android/i.test(ua)) return "android";
  const tauri =
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
  if (tauri) return "desktop";
  return "browser";
}

/** The other pane on a two-device split — never "Server". */
export function otherDeviceLabel(): string {
  return deviceRole() === "android" ? "Desktop" : "Tablet";
}

export function collectDevicePrefsBlob(): Record<string, unknown> {
  const tools = loadInkToolPresets();
  return {
    handedness: loadInkHandedness(),
    testForward: loadTestForwardMode(),
    captureMode: loadCaptureMode(),
    captureDestination: loadCaptureDestination(),
    captureFolder: loadCaptureFolder(),
    captureCountdown: loadCaptureCountdown(),
    offlineMerge: loadOfflineMergePolicy(),
    pressureClip: loadInkPressureClip(),
    inkSmoothing: loadInkSmoothing(),
    inkSmoothingMode: loadInkSmoothingMode(),
    inkSpeed: loadInkSpeed(),
    inkSpeedBlotBlend: loadInkSpeedBlotBlend(),
    inkSpeedFade: loadInkSpeedFade(),
    inkSpeedBodyAccent: loadInkSpeedBodyAccent(),
    inkBoldness: loadInkBoldness(),
    eraserPartial: loadEraserPartial(),
    autosaveMs: loadAutosaveInterval(),
    autosaveBanner: loadAutosaveBanner(),
    paletteTag: loadPaletteTag(),
    colorWheelOnToolbar: tools.colorWheelOnToolbar,
    tapOk: tools.tapOk,
    chromeWake: loadChromeWakeMarker(),
    chromeWakeTint: loadChromeWakeTint(),
    themeId: loadThemeId(),
  };
}

export function applyDevicePrefsBlob(prefs: Record<string, unknown>): void {
  if (typeof prefs.handedness === "string") saveInkHandedness(prefs.handedness as InkHandedness);
  if (prefs.testForward === "wait" || prefs.testForward === "whole-run" || prefs.testForward === "per-case") {
    saveTestForwardMode(prefs.testForward);
  } else if (typeof prefs.forwardFailures === "boolean") {
    saveTestForwardMode(prefs.forwardFailures ? "whole-run" : "wait");
  }
  if (typeof prefs.captureMode === "string") saveCaptureMode(prefs.captureMode as never);
  if (typeof prefs.captureDestination === "string") {
    saveCaptureDestination(prefs.captureDestination as never);
  }
  if (typeof prefs.captureFolder === "string") saveCaptureFolder(prefs.captureFolder);
  if (typeof prefs.captureCountdown === "number") saveCaptureCountdown(prefs.captureCountdown);
  if (typeof prefs.offlineMerge === "string") saveOfflineMergePolicy(prefs.offlineMerge as never);
  if (typeof prefs.pressureClip === "number") saveInkPressureClip(prefs.pressureClip);
  if (typeof prefs.inkSmoothing === "number") saveInkSmoothing(prefs.inkSmoothing);
  if (typeof prefs.inkSmoothingMode === "string") {
    saveInkSmoothingMode(prefs.inkSmoothingMode as never);
  }
  if (typeof prefs.inkSpeed === "number") saveInkSpeed(prefs.inkSpeed);
  if (typeof prefs.inkSpeedBlotBlend === "number") saveInkSpeedBlotBlend(prefs.inkSpeedBlotBlend);
  if (typeof prefs.inkSpeedFade === "number") saveInkSpeedFade(prefs.inkSpeedFade);
  if (typeof prefs.inkSpeedBodyAccent === "number") {
    saveInkSpeedBodyAccent(prefs.inkSpeedBodyAccent);
  }
  if (typeof prefs.inkBoldness === "number") saveInkBoldness(prefs.inkBoldness);
  if (typeof prefs.eraserPartial === "boolean") saveEraserPartial(prefs.eraserPartial);
  if (typeof prefs.autosaveMs === "number") saveAutosaveInterval(prefs.autosaveMs as never);
  if (prefs.autosaveBanner === "on" || prefs.autosaveBanner === "off") {
    saveAutosaveBanner(prefs.autosaveBanner);
  }
  if (typeof prefs.paletteTag === "string") savePaletteTag(prefs.paletteTag as never);
  if (typeof prefs.colorWheelOnToolbar === "boolean" || typeof prefs.tapOk === "boolean") {
    saveInkToolPresets({
      ...loadInkToolPresets(),
      ...(typeof prefs.colorWheelOnToolbar === "boolean"
        ? { colorWheelOnToolbar: prefs.colorWheelOnToolbar }
        : {}),
      ...(typeof prefs.tapOk === "boolean" ? { tapOk: prefs.tapOk } : {}),
    });
  }
  if (typeof prefs.chromeWake === "string") saveChromeWakeMarker(prefs.chromeWake as never);
  if (typeof prefs.chromeWakeTint === "string") saveChromeWakeTint(prefs.chromeWakeTint as never);
  if (typeof prefs.themeId === "string") {
    saveThemeId(prefs.themeId);
    if (typeof document !== "undefined") applyAppTheme(prefs.themeId);
  }
}

function alreadyCloned(): boolean {
  try {
    return localStorage.getItem(CLONED_KEY) === "1";
  } catch {
    return false;
  }
}

function markCloned(): void {
  try {
    localStorage.setItem(CLONED_KEY, "1");
  } catch {
    /* ignore */
  }
}

export async function ensureDevicePrefs(client: LcClient): Promise<DevicePrefsDto | null> {
  const id = loadDeviceId();
  const role = deviceRole();
  const existing = await client.getDevicePrefs(id);
  if (existing) return existing;
  if (role === "desktop" && !alreadyCloned()) {
    const cloned = await client.cloneDevicePrefs(id, role);
    if (cloned && cloned.prefs && typeof cloned.prefs === "object") {
      applyDevicePrefsBlob(cloned.prefs as Record<string, unknown>);
      markCloned();
      return cloned;
    }
  }
  return client.putDevicePrefs(id, {
    id,
    role,
    prefs: collectDevicePrefsBlob(),
    updated_at: Date.now(),
  });
}

export async function saveThisDevicePrefs(client: LcClient): Promise<DevicePrefsDto> {
  const id = loadDeviceId();
  return client.putDevicePrefs(id, {
    id,
    role: deviceRole(),
    prefs: collectDevicePrefsBlob(),
    updated_at: Date.now(),
  });
}

export function resetDevicePrefsCloneForTests(): void {
  try {
    localStorage.removeItem(CLONED_KEY);
    localStorage.removeItem(DEVICE_ID_KEY);
  } catch {
    /* ignore */
  }
}
