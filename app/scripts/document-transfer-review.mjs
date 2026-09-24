// Run from app/: node scripts/document-transfer-review.mjs <path-to-pdf>
// Prerequisite: cargo build --no-default-features --example sync_review_hub
// Uses a fresh local hub directory, never the installed app's data.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const input = process.argv[2];
assert(input, "Pass a PDF file to verify");
const source = resolve(input);
const size = (await stat(source)).size;
const expected = createHash("sha256");
for await (const chunk of createReadStream(source)) expected.update(chunk);
const digest = expected.digest("hex");
const root = resolve(`../.tmp-phase3-checks/document-transfer-${randomUUID()}`);
const hub = spawn(resolve("../target/debug/examples/sync_review_hub.exe"), [root],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let failure = "";
hub.on("error", error => { failure = error.message; });
hub.stderr.on("data", data => { failure += data; });
const base = "http://127.0.0.1:1458";
const headers = { "x-lc-token": "sync-review" };
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (failure || hub.exitCode !== null) throw new Error(failure || "Test hub exited");
    try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, "Test hub did not start");
  const url = `${base}/docs/${digest}/bytes`;
  const uploaded = await fetch(url, { method: "PUT", headers: {
    ...headers, "content-type": "application/octet-stream", "content-length": String(size),
  }, body: createReadStream(source), duplex: "half" });
  assert.equal(uploaded.status, 204, await uploaded.text());
  const head = await fetch(url, { method: "HEAD", headers });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), size);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const download = await fetch(url, { headers });
  assert.equal(download.status, 200);
  const received = createHash("sha256");
  let bytes = 0;
  for await (const chunk of download.body) { received.update(chunk); bytes += chunk.length; }
  assert.equal(bytes, size);
  assert.equal(received.digest("hex"), digest);
  console.log(`PASS real HTTP upload/HEAD/download: ${size} bytes, identical SHA-256`);
} finally { hub.kill(); }
