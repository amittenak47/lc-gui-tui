import { it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scripts = execFileSync("git", ["ls-files", "-z", "--", "*.cmd"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);

it("tracked batch files are ASCII and use CRLF, with a Git rule preserving it", () => {
  assert.ok(scripts.length);
  for (const path of scripts) {
    const bytes = readFileSync(join(root, path));
    assert.ok(bytes.every(byte => byte < 128), `${path} contains non-ASCII bytes`);
    assert.doesNotMatch(bytes.toString("ascii"), /(?<!\r)\n/, `${path} contains a bare LF`);
    const attrs = execFileSync("git", ["check-attr", "eol", "--", path], { cwd: root, encoding: "utf8" });
    assert.match(attrs, /eol: crlf/);
  }
});

it.skipIf(process.platform !== "win32")("cmd.exe can parse each script's comment preamble", () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-cmd-check-"));
  try {
    for (const [index, path] of scripts.entries()) {
      // Read comments only: this checks cmd parsing without building, installing,
      // restarting services, or running the script's filesystem commands.
      const comments = readFileSync(join(root, path), "ascii").split(/\r?\n/).filter(line => /^\s*(?:REM(?:\s|$)|::)/i.test(line));
      const probe = join(dir, `probe-${index}.cmd`);
      writeFileSync(probe, ["@echo off", ...comments, "echo parsed", "exit /b 0", ""].join("\r\n"), "ascii");
      const result = execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", probe], { encoding: "utf8", windowsHide: true });
      assert.equal(result.trim(), "parsed", path);
    }
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
});
