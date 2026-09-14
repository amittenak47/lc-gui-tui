// Run with Vite on 127.0.0.1:1441. Chrome uses an isolated profile.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const out = resolve("../.tmp-markdown-reopen-review");
await mkdir(out, { recursive: true });
const profile = resolve(out, `chrome-${process.pid}`);
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1441", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (data) => process.stderr.write(data));
server.on("exit", (code) => console.log("Vite exit", code));
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { windowsHide: true, stdio: "ignore" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
  for (let i = 0; i < 100; i++) {
    try { await fetch("http://127.0.0.1:1441/", { signal: AbortSignal.timeout(1000) }); break; } catch { await sleep(100); }
  }
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch { await sleep(100); }
  }
  assert(port, "Chrome did not start");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  const requests = new Map();
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args);
    if (msg.method === "Network.requestWillBeSent") requests.set(msg.params.requestId, msg.params.request.url);
    if (msg.method === "Network.loadingFinished" || msg.method === "Network.loadingFailed") requests.delete(msg.params.requestId);
    if (msg.method === "Network.loadingFailed") errors.push(msg.params);
    if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) errors.push(msg.params.response);
    const req = pending.get(msg.id);
    if (req) { pending.delete(msg.id); msg.error ? req.reject(msg.error) : req.resolve(msg.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CDP timed out: ${method}`)), 15000);
    pending.set(++id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (cause) => { clearTimeout(timeout); reject(cause); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(out, `${name}.png`), Buffer.from(data, "base64"));
  };
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.enable");

  await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: "http://127.0.0.1:1441/scripts/sync-ui-review.html" });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (await evaluate("Boolean(window.reviewReady)")) { ready = true; break; }
    await sleep(100);
  }
  assert(ready, "Board did not become ready");

  const bounds = () => evaluate("window.reviewBoard.getViewportBounds()");
  const wheel = async () => {
    const before = await bounds();
    await send("Input.dispatchMouseEvent", {type:"mouseWheel", x:450, y:650, deltaX:0, deltaY:600});
    await sleep(500);
    const after = await bounds();
    return {before,after,delta:after.y-before.y};
  };
  const fresh = await wheel();
  assert(fresh.delta > 100, "Fresh Markdown does not scroll");
  const saved = await evaluate(`(async () => {
    const {saveAnnotateDoc,getAnnotateDoc} = await import('/src/util/annotateStore.ts');
    const board = window.reviewBoard;
    const blob = board.saveBoard();
    await saveAnnotateDoc({id:'isolated-reopen',name:'long.md',hash:'fixture',source:'Long markdown',docType:'markdown',board:blob,agent:[],footnotes:[]});
    const stored = await getAnnotateDoc('isolated-reopen');
    board.restoreBoard(stored.board.elements,stored.board.appState,{skipFit:true});
    board.restoreView(stored.board.appState);
    board.syncDocumentScrollBounds(); board.armReadingScroll();
    return stored.board.appState;
  })()`);
  await sleep(500);
  const reopened = await wheel();
  await shot('markdown-reopened');
  await writeFile(resolve(out,'results.json'),JSON.stringify({fresh,saved,reopened,errors},null,2));
  console.log(JSON.stringify({fresh,saved,reopened}));
  assert(reopened.delta > 100, "Saved annotation camera blocks Markdown scrolling on reopen");
} finally { socket?.close(); chrome.kill(); server.kill(); }
