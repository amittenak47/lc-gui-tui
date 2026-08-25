/**
 * Wireless adb for the tablet (Android 11+ wireless debugging).
 *
 * XPPen Magic Note Pad is Android 14 — this is the stock Developer Options
 * path, not a vendor-specific tool. Same Wi-Fi as the PC. Pairing code is
 * once per machine; the connect port changes after a reboot or a toggle.
 *
 * From app/:
 *   npm run adb:pair -- 192.168.1.20:37123 123456
 *   npm run adb:connect -- 192.168.1.20:41259
 *   npm run adb:reconnect
 *   npm run android:wireless:practice
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, "..");
const STATE_PATH = join(APP_ROOT, ".adb-wireless");

export function parseTarget(raw) {
  const text = String(raw ?? "").trim();
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+):(\d{2,5})$/.exec(text);
  if (!match) return null;
  return { host: match[1], port: match[2], serial: `${match[1]}:${match[2]}` };
}

/** Prefer a tcpip serial (`ip:port`) over USB `emulator-` / hex ids. */
export function pickWirelessSerial(devicesText) {
  const lines = String(devicesText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices"));
  const wireless = [];
  const usb = [];
  for (const line of lines) {
    const [serial, state] = line.split(/\s+/);
    if (!serial || state !== "device") continue;
    if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(serial)) {
      wireless.push(serial);
    } else {
      usb.push(serial);
    }
  }
  return wireless[0] ?? usb[0] ?? null;
}

/** Saved wireless serial if still listed; else pickWirelessSerial. */
export function resolveSerial(devicesText, savedSerial) {
  const text = String(devicesText ?? "");
  const saved = String(savedSerial ?? "").trim();
  if (saved) {
    for (const line of text.split(/\r?\n/)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial === saved && state === "device") return saved;
    }
  }
  return pickWirelessSerial(text);
}

function adbBin() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || join(process.env.LOCALAPPDATA || "", "Android", "Sdk");
  const bundled = join(home, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  if (existsSync(bundled)) return bundled;
  return "adb";
}

function runAdb(args, opts = {}) {
  const result = spawnSync(adbBin(), args, {
    encoding: "utf8",
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ANDROID_HOME: process.env.ANDROID_HOME
        || process.env.ANDROID_SDK_ROOT
        || join(process.env.LOCALAPPDATA || "", "Android", "Sdk"),
    },
  });
  return result;
}

function saveState(serial) {
  writeFileSync(STATE_PATH, `${serial}\n`, "utf8");
}

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  return parseTarget(readFileSync(STATE_PATH, "utf8").trim());
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function usage() {
  console.log(`Wireless adb (Android 11+). Magic Note Pad is Android 14 — this works.

On the tablet: Settings → Developer options → Wireless debugging ON.
Tap Wireless debugging. Pairing code screen uses a *different* port than
the main "IP address & Port" line.

  node scripts/android-adb-wireless.mjs pair <ip:pairingPort> <6-digit-code>
  node scripts/android-adb-wireless.mjs connect <ip:connectPort>
  node scripts/android-adb-wireless.mjs reconnect
  node scripts/android-adb-wireless.mjs devices
  node scripts/android-adb-wireless.mjs install practice
  node scripts/android-adb-wireless.mjs install whiteboard
  node scripts/android-adb-wireless.mjs logcat open
  node scripts/android-adb-wireless.mjs logcat
  node scripts/android-adb-wireless.mjs logcat clear

Same Wi-Fi. Guest / AP isolation will fail. After sleep or reboot, connect
again — the port usually changed.
`);
}

function pair(targetRaw, code) {
  const target = parseTarget(targetRaw);
  if (!target || !code) {
    fail("Usage: pair <ip:pairingPort> <6-digit-code>");
    return;
  }
  const result = runAdb(["pair", target.serial, String(code)], { stdio: "inherit" });
  if (result.status !== 0) {
    fail("adb pair failed. Code expires fast — generate a new one on the tablet.");
    return;
  }
  console.log("Paired. Now connect with the *main* Wireless debugging IP:port (not the pairing port).");
}

function connect(targetRaw) {
  const target = parseTarget(targetRaw);
  if (!target) {
    fail("Usage: connect <ip:connectPort>   (the IP & port on the main Wireless debugging screen)");
    return;
  }
  const result = runAdb(["connect", target.serial], { stdio: "inherit" });
  if (result.status !== 0) {
    fail("adb connect failed.");
    return;
  }
  saveState(target.serial);
  console.log(`Saved ${target.serial} to .adb-wireless (gitignored). Later: npm run adb:reconnect`);
}

function reconnect() {
  const saved = loadState();
  if (!saved) {
    fail("No saved target. npm run adb:connect -- <ip:port> from the tablet's Wireless debugging screen.");
    return;
  }
  connect(saved.serial);
}

function devices() {
  const result = runAdb(["devices", "-l"], { stdio: "inherit" });
  if (result.status !== 0) fail("adb devices failed. Is platform-tools on PATH?");
}

function attachedSerial() {
  const devicesOut = runAdb(["devices"]);
  if (devicesOut.status !== 0) {
    fail("adb devices failed.");
    return null;
  }
  const serial = resolveSerial(devicesOut.stdout || "", loadState()?.serial ?? null);
  if (!serial) {
    fail("No adb device. Pair + connect first (Wireless debugging, same Wi-Fi).");
    return null;
  }
  return serial;
}

function logcat(kind) {
  const serial = attachedSerial();
  if (!serial) return;
  const args = ["-s", serial, "logcat"];
  if (kind === "clear") args.push("-c");
  else if (kind === "open") args.push("-s", "Tauri/Console:D", "-e", "lc:open");
  else args.push("-s", "Tauri/Console:D");
  console.error(`adb -s ${serial} logcat${kind === "open" ? " (lc:open)" : kind === "clear" ? " -c" : ""}`);
  const result = runAdb(args, { stdio: "inherit" });
  process.exitCode = result.status === 0 ? 0 : 1;
}

function install(flavor) {
  const kind = flavor === "whiteboard" ? "whiteboard" : "practice";
  const serial = attachedSerial();
  if (!serial) return;
  const script = process.platform === "win32"
    ? join(SCRIPT_DIR, `android-install-${kind}.cmd`)
    : join(SCRIPT_DIR, `android-install-${kind}.sh`);
  if (!existsSync(script)) {
    fail(`missing ${script}`);
    return;
  }
  console.log(`Building + installing ${kind} to ${serial}`);
  const result = spawnSync(
    process.platform === "win32" ? script : "bash",
    process.platform === "win32" ? [serial] : [script, serial],
    { stdio: "inherit", cwd: APP_ROOT, shell: process.platform === "win32" },
  );
  process.exitCode = result.status === 0 ? 0 : 1;
}

async function main() {
  mkdirSync(APP_ROOT, { recursive: true });
  const [, , cmd, a, b] = process.argv;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }
  if (cmd === "pair") return pair(a, b);
  if (cmd === "connect") return connect(a);
  if (cmd === "reconnect") return reconnect();
  if (cmd === "devices" || cmd === "status") return devices();
  if (cmd === "install") return install(a);
  if (cmd === "logcat" || cmd === "logs") return logcat(a);
  fail(`unknown command: ${cmd}`);
  usage();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
