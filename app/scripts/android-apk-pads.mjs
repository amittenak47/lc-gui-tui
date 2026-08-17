/**
 * Pads-only APK: hide Practice in Vite and omit the `leetcode` Cargo feature
 * (no RustPython, no seed extract). Both flags must stay together.
 *
 * Usage (from app/):
 *   node scripts/android-apk-pads.mjs --debug
 *   node scripts/android-apk-pads.mjs
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const debug = process.argv.includes("--debug");

process.env.VITE_FEATURE_LEETCODE = "0";

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: APP_DIR,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

run("node", ["scripts/android-overlay.mjs"]);
run("npm", ["run", "icons:sync"]);

const tauri = ["exec", "--", "tauri", "android", "build", "--apk"];
if (debug) tauri.push("--debug");
tauri.push("--", "--no-default-features");
run("npm", tauri);
