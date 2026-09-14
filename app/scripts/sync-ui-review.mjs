// Run with Vite on 127.0.0.1:1439. Chrome uses an isolated profile.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const out = resolve("../.tmp-sync-ui-review");
await mkdir(out, { recursive: true });
const profile = resolve(out, `chrome-${process.pid}`);
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1439", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
    try { await fetch("http://127.0.0.1:1439/", { signal: AbortSignal.timeout(1000) }); break; } catch { await sleep(100); }
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
  await send("Page.navigate", { url: "http://127.0.0.1:1439/scripts/sync-ui-review.html" });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (await evaluate("Boolean(window.reviewReady)")) { ready = true; break; }
    await sleep(100);
  }
  assert(ready, "Board did not become ready");
  const storage = await evaluate(`(async () => {
    const store = await import('/src/util/inkPageStore.ts');
    const codec = await import('/src/canvas/inkCodec.ts');
    const gzip = await import('/src/util/gzip.ts');
    const sync = await import('/src/util/inkSync.ts');
    const { setHostLoopback } = await import('/src/util/padHub.ts');
    setHostLoopback({url:'http://fixture',token:'test'});
    const docKey = 'wb:isolated-review';
    const ink = codec.encodeInkOps([{kind:'draw',color:'#334455',baseWidth:2,maxFullness:1,pressureClip:1,pressureSensitive:false,points:[{x:10,y:20,pressure:0.5},{x:40,y:60,pressure:0.5}]}]);
    await store.putInkPages(docKey, [[1,ink]], {now:100});
    const hub = new Map();
    const client = { putInkPage: async row => {hub.set(row.page_id,row);return {applied:true,seq:0};},getInkPages: async () => [...hub.values()] };
    await sync.syncInkPages(client,[],[{kind:'whiteboard',key:'isolated-review'}],0,{strict:true});
    const gz = await gzip.gzipBytes(codec.packEncodedInk(ink));
    await store.putInkPageArchive(docKey,1,gz,100);
    const archived = await store.getInkPageRecord(docKey,1);
    await store.putInkPages(docKey,[[1,ink]],{now:200});
    const conflicts = await sync.syncInkPages(client,[...hub.values()],[{kind:'whiteboard',key:'isolated-review'}],0,{strict:true});
    return {archiveAt:archived.updatedAt,archiveAck:archived.syncedUpdatedAt,conflicts:conflicts.length,hubAt:hub.get(1).updated_at};
  })()`);
  assert.deepEqual(storage, {archiveAt:100,archiveAck:100,conflicts:0,hubAt:200});
  const reload = await evaluate(`(async () => {
    const {hubReloadAppState,hubReloadDocumentElements}=await import('/src/util/boardHubReload.ts');
    const board=window.reviewBoard;
    board.setInkOps([{kind:'draw',color:'#334455',baseWidth:3,maxFullness:1,pressureClip:1,pressureSensitive:false,points:[{x:120,y:220,pressure:0.5},{x:280,y:260,pressure:0.5}]}]);
    const live=board.saveBoard({assembleInk:false});
    const saved=live.elements.map(el=>el.id==='lcmdink-0-frame'?{...el,height:1100}:el);
    board.restoreBoard(hubReloadDocumentElements(saved,live.elements),hubReloadAppState(live.appState,{...live.appState,linedPaperMode:'off'}),{skipFit:true});
    board.syncDocumentScrollBounds();board.armReadingScroll();
    return {height:board.getElements().find(el=>el.id==='lcmdink-0-frame')?.height,ink:board.getInkOpCount()};
  })()`);
  assert(reload.height > 10000, `Reload shortened document: ${JSON.stringify(reload)}`);
  assert(reload.ink > 0, "Reload removed live ink");
  await sleep(200);
  const before = await evaluate("window.reviewBoard.getViewportBounds()");
  await send("Input.dispatchMouseEvent", {type:"mouseWheel", x:450, y:650, deltaX:0, deltaY:900});
  await sleep(400);
  const after = await evaluate("window.reviewBoard.getViewportBounds()");
  assert(after.y > before.y + 100, `Post-reload wheel failed: ${JSON.stringify({before,after})}`);
  await evaluate("window.reviewShowEditor()");
  await evaluate("import('/src/util/notifications.ts').then(m=>{m.showNotification('Scroll mode',8000);m.showNotification('Annotation is available in Preview',8000);})");
  await sleep(300);
  const editor = await evaluate("(()=>{const box=document.querySelector('.lc-color-slot-editor').getBoundingClientRect();return {left:box.left,top:box.top,right:box.right,bottom:box.bottom,width:box.width,height:box.height};})()");
  assert(editor.left >= 0 && editor.top >= 0 && editor.right <= 900 && editor.bottom <= 1100, `Editor overflow: ${JSON.stringify(editor)}`);
  await shot('sync-and-notifications');
  await evaluate("window.reviewShowAgent()");
  await sleep(500);
  const bounds = () => evaluate(`(() => {
    const header=document.querySelector('.lc-app .lc-header').getBoundingClientRect();
    const sheet=document.querySelector('.lc-side').getBoundingClientRect();
    return {headerTop:header.top,headerBottom:header.bottom,sheetTop:sheet.top,sheetBottom:sheet.bottom,height:innerHeight,bodyScroll:document.scrollingElement.scrollTop};
  })()`);
  const cycles=[];
  for(let cycle=0;cycle<3;cycle++) {
    await evaluate("document.querySelector('.lc-agent-thread-open').click()");
    await sleep(500);
    await evaluate("document.querySelector('.lc-agent-thread-back').click()");
    await sleep(600);
    await evaluate("document.querySelector('.lc-agent-sheet-handle').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await sleep(300);
    const parked=await bounds();cycles.push(parked);
    assert(Math.abs(parked.sheetTop-(parked.height-52))<2,`Sheet drift: ${JSON.stringify(parked)}`);
    assert(parked.headerTop>=0 && parked.bodyScroll===0,`Header drift: ${JSON.stringify(parked)}`);
    if(cycle<2) {
      await evaluate("document.querySelector('.lc-agent-sheet-handle').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
      await sleep(300);
    }
  }
  await shot('agent-drawing-panel');
  await evaluate("document.querySelector('.lc-document-drawing-panel [aria-label=\"Next step\"]').click()");
  await sleep(150);
  assert.equal(await evaluate("document.querySelector('.lc-document-drawing-panel .lc-timeline-count').textContent"),'Step 2 of 2');
  await evaluate("document.querySelector('.lc-document-drawing-panel [aria-label=\"Hide drawing\"]').click()");
  await sleep(150);
  assert.equal(await evaluate("Boolean(document.querySelector('.lc-document-drawing-panel'))"),false);
  await writeFile(resolve(out,'results.json'),JSON.stringify({storage,reload,before,after,editor,cycles,errors},null,2));
  assert(errors.length === 0, `Browser errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({storage,reload,scrollDelta:after.y-before.y,editor}));
} finally {
  socket?.close(); chrome.kill(); server.kill();
}
