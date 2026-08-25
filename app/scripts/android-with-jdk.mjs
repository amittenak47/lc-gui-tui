/**
 * Run a command with JAVA_HOME set to a JDK Gradle can actually use.
 *
 * Tauri's Android build prefers Android Studio's JBR. That JBR is now 25.0.2;
 * `buildSrc` then fails with that version as the entire error. Overlay already
 * wrote `org.gradle.java.home`; this also sets JAVA_HOME so the Gradle spawn
 * does not pick JBR first.
 *
 * Usage (from app/): node scripts/android-with-jdk.mjs tauri android build ...
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gradleJdkEnv, pickGradleJdkHome } from "./android-overlay.mjs";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const jdk = pickGradleJdkHome();
if (!jdk) {
  console.error("android-with-jdk: no JDK 17–24. Set JAVA_HOME and retry.");
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("Usage: node scripts/android-with-jdk.mjs <command> [args...]");
  process.exit(1);
}

const result = spawnSync(cmd, args, {
  cwd: APP_DIR,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: gradleJdkEnv(jdk),
});
process.exit(result.status ?? 1);
