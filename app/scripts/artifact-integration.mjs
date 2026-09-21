// Real IndexedDB in two isolated Chrome profiles; never opens the user's app data.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = 1457;
const children = [];
const sockets = [];
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
children.push(server);
let serverError = "";
server.stderr.on("data", data => { serverError += data; });
async function browser(label) {
  const profile = resolve(`../.tmp-phase3-checks/${process.pid}-${label}`);
  await mkdir(profile, { recursive: true });
  const child = spawn(process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  children.push(child);
  let debugPort;
  for (let i = 0; i < 100 && !debugPort; i++) {
    try { debugPort = (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch { await sleep(100); }
  }
  assert(debugPort, "Chrome did not start");
  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(); let seq = 0;
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data); const request = pending.get(msg.id);
    if (request) { pending.delete(msg.id); msg.error ? request.reject(msg.error) : request.resolve(msg.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve: v => { clearTimeout(timeout); resolve(v); }, reject: e => { clearTimeout(timeout); reject(e); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  async function ready() {
    for (let i = 0; i < 200; i++) {
      if (await evaluate("Boolean(window.artifactChecks)")) return;
      await sleep(100);
    }
    throw new Error("Artifact fixture did not load");
  }
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/scripts/artifact-integration.html` });
  await ready();
  return { call: (name, ...args) => evaluate(`window.artifactChecks[${JSON.stringify(name)}](...${JSON.stringify(args)})`),
    evaluate, send,
    crash: async () => { await send("Page.crash").catch(() => {}); },
    reload: async () => { await send("Page.reload"); await sleep(200); await ready(); } };
}
try {
  let started = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(serverError || "Vite exited");
    try { await fetch(`http://127.0.0.1:${port}/scripts/artifact-integration.html`); started = true; break; }
    catch { await sleep(100); }
  }
  assert(started, "Vite did not start");
  const a = await browser("a"), b = await browser("b");
  const initial = await a.call("seed");
  await b.call("missing", initial);
  assert.equal((await b.call("receive", initial)).value.source, "initial");
  console.log("PASS dependency failure/retry and two-client create/sync/reopen");
  await a.call("edit", "device A");
  const remote = await b.call("edit", "device B");
  const merged = await a.call("conflict", remote);
  await b.call("receive", merged);
  console.log("PASS divergent edits preserve both authored versions and converge");
  const draftRef = await a.call("draft");
  await a.crash();
  await a.reload();
  await a.call("recover", draftRef);
  console.log("PASS persistent draft recovery after renderer process crash");
  await a.call("lifecycle");
  console.log("PASS delete and explicit restore ancestry");
  await a.call("snapshots");
  console.log("PASS real transaction abort rolls back content and ink; snapshot reopen succeeds");
  await a.call("gc");
  console.log("PASS cache retention keeps live/draft/unacknowledged content");
  await a.call("keepBothCanvases");
  console.log("PASS keep-both problem canvases retain editable scene and handwriting");
  await a.call("picker");
  for (const width of [1100, 390]) {
    await a.send("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
    for (const source of ["Files", "Pages & regions"]) {
      await sleep(400);
      await a.evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(source)}).click()`);
      await sleep(200);
      const layout = await a.evaluate(`(() => {
        const modal = document.querySelector('.lc-artifact-picker-modal');
        const buttons = [...modal.querySelectorAll('button')].filter(b => b.textContent === 'Attach excerpt');
        return { overflow: modal.scrollWidth > modal.clientWidth + 1, rows: buttons.length,
          visible: buttons.every(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }) };
      })()`);
      assert(!layout.overflow && layout.rows > 0 && layout.visible, `picker layout ${width}/${source}: ${JSON.stringify(layout)}`);
      const shot = await a.send("Page.captureScreenshot", { format: "png" });
      await writeFile(resolve(`../.tmp-phase3-checks/picker-${width}-${source === "Files" ? "files" : "regions"}.png`), Buffer.from(shot.data, "base64"));
    }
  }
  console.log("PASS existing picker layout at desktop and phone widths");
} finally {
  for (const socket of sockets) socket.close();
  for (const child of children.reverse()) child.kill();
}
