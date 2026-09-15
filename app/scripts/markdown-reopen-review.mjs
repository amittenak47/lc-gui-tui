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
  const rendering = await evaluate(`(async () => {
    const doc = document.querySelector('.lc-md-ink-doc');
    const heading = doc.querySelector('h2');
    let replacements = 0;
    const observer = new MutationObserver(records => replacements += records.length);
    observer.observe(doc, {childList:true, subtree:true});
    for (let i=0; i<20; i++) {
      window.reviewRerender();
      await new Promise(requestAnimationFrame);
    }
    observer.disconnect();
    return {replacements, sameHeading: heading === doc.querySelector('h2'),
      headings: doc.querySelectorAll('h2').length, height:doc.offsetHeight};
  })()`);
  assert.equal(rendering.replacements, 0, 'UI updates rebuilt the Markdown DOM');
  assert(rendering.sameHeading && rendering.headings === 100 && rendering.height > 5000);

  // Sample actual browser layout work during a stream of wheel events.
  await send('Performance.enable');
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map(m => [m.name,m.value]));
  const beforeScroll = await metrics();
  for (let i=0; i<30; i++) {
    await send('Input.dispatchMouseEvent', {type:'mouseWheel', x:450, y:650, deltaX:0, deltaY:35});
    await sleep(16);
  }
  const afterScroll = await metrics();
  const scrollWork = {layouts: afterScroll.LayoutCount-beforeScroll.LayoutCount,
    layoutMs: (afterScroll.LayoutDuration-beforeScroll.LayoutDuration)*1000,
    scriptMs: (afterScroll.ScriptDuration-beforeScroll.ScriptDuration)*1000};
  await shot('markdown-rendering');

  // Park and close during camera motion: neither may leave global paint holds.
  const beforePark = await bounds();
  await evaluate('window.reviewSetShowing(false)');
  await sleep(100);
  const parked = await evaluate(`(async () => {
    const {isDocCameraLive} = await import('/src/canvas/docSelectionGesture.ts');
    return {live:isDocCameraLive(), promoted:document.documentElement.classList.contains('lc-doc-camera-live')};
  })()`);
  assert(!parked.live && !parked.promoted, 'Parked Markdown retains camera hold');
  await evaluate('window.reviewSetShowing(true)');
  await sleep(500);
  const resumed = await bounds();
  assert(Math.abs(resumed.y-beforePark.y) < 1 && Math.abs(resumed.zoom-beforePark.zoom) < 0.001,
    'Returning to Markdown changed the reading camera');
  await wheel();
  await send('Input.dispatchMouseEvent', {type:'mouseWheel', x:450, y:650, deltaX:0, deltaY:80});
  await sleep(30);
  await evaluate('window.reviewClose()');
  await sleep(100);
  const closed = await evaluate(`(async () => {
    const {isDocCameraLive} = await import('/src/canvas/docSelectionGesture.ts');
    return {live:isDocCameraLive(), promoted:document.documentElement.classList.contains('lc-doc-camera-live')};
  })()`);
  assert(!closed.live && !closed.promoted, 'Closed Markdown retains camera hold');
  await evaluate('window.reviewShowTabs()');
  await sleep(100);
  const tabOrder = () => evaluate(`Array.from(document.querySelectorAll('.lc-tab')).map(tab => tab.dataset.tabId)`);
  const tabRect = id => evaluate(`(() => {
    const r = document.querySelector('[data-tab-id="${id}"]').getBoundingClientRect();
    return {left:r.left,right:r.right,x:(r.left+r.right)/2,y:(r.top+r.bottom)/2};
  })()`);
  const dragTab = async (id, targetId, side) => {
    const from = await tabRect(id), to = await tabRect(targetId);
    const x = side === 'before' ? to.left + 2 : side === 'after' ? to.right - 2 : to.x;
    await send('Input.dispatchMouseEvent', {type:'mousePressed',x:from.x,y:from.y,button:'left',buttons:1,clickCount:1});
    await send('Input.dispatchMouseEvent', {type:'mouseMoved',x,y:to.y,button:'left',buttons:1});
    await sleep(50);
    if (side) assert(await evaluate("Boolean(document.querySelector('.lc-tab-insertion'))"), 'No insertion marker');
    await send('Input.dispatchMouseEvent', {type:'mouseReleased',x,y:to.y,button:'left',buttons:0,clickCount:1});
    await sleep(100);
  };
  await dragTab('review-d','review-b','before');
  assert.deepEqual(await tabOrder(), ['review-a','review-d','review-b','review-c']);
  await dragTab('review-a','review-c','after');
  assert.deepEqual(await tabOrder(), ['review-d','review-b','review-c','review-a']);
  await dragTab('review-c','review-b',null);
  await dragTab('review-c','review-b',null);
  assert.deepEqual(await tabOrder(), ['review-d','review-c','review-b','review-a']);
  assert.equal(await evaluate("document.querySelectorAll('.lc-tab-row.is-group').length"), 1);
  await shot('tab-reordering');
  console.log(JSON.stringify({tabReorder:'passed', splitSwap:'passed'}));
  await writeFile(resolve(out,'results.json'),JSON.stringify({fresh,saved,reopened,rendering,scrollWork,parked,closed,errors},null,2));
  console.log(JSON.stringify({rendering,scrollWork,parked,closed,errors}));
} finally { socket?.close(); chrome.kill(); server.kill(); }
