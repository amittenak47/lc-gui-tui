/**
 * Whiteboard-only APK: hide Practice in Vite and omit the `leetcode` Cargo
 * feature (no RustPython, no seed extract). Both flags must stay together —
 * dropping the feature without the Vite flag ships a Practice card that opens
 * onto a judge that is not in the binary.
 *
 * Usage (from app/):
 *   node scripts/android-apk-whiteboard.mjs --debug
 *   node scripts/android-apk-whiteboard.mjs
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gradleJdkEnv, pickGradleJdkHome } from "./android-overlay.mjs";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const debug = process.argv.includes("--debug");

process.env.VITE_FEATURE_LEETCODE = "0";

function run(cmd, args, env = process.env) {
  const result = spawnSync(cmd, args, {
    cwd: APP_DIR,
    stdio: "inherit",
    shell: true,
    env,
  });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

run("node", ["scripts/android-overlay.mjs"]);
run("npm", ["run", "icons:sync"]);

const jdk = pickGradleJdkHome();
if (!jdk) {
  console.error("android-apk-whiteboard: no JDK 17–24. Set JAVA_HOME and retry.");
  process.exit(1);
}
const env = gradleJdkEnv(jdk);

const tauri = ["exec", "--", "tauri", "android", "build", "--apk"];
if (debug) tauri.push("--debug");
tauri.push("--", "--no-default-features");
run("npm", tauri, env);
