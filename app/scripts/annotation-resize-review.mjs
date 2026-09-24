// Run with Vite on 127.0.0.1:1452. Chrome uses an isolated profile.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const out = resolve("../.tmp-agent-motion-review");
await mkdir(out, { recursive: true });
const profile = resolve(out, `chrome-${process.pid}`);
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1452", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
    try { await fetch("http://127.0.0.1:1452/", { signal: AbortSignal.timeout(1000) }); break; } catch { await sleep(100); }
  }
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch { await sleep(100); }
  }
  assert(port, "Chrome did not start");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(browser.webSocketDebuggerUrl);
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
  let mainSession;
  const send = (method, params = {}, sessionId = mainSession) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CDP timed out: ${method}`)), 15000);
    pending.set(++id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (cause) => { clearTimeout(timeout); reject(cause); } });
    socket.send(JSON.stringify({ id, method, params, sessionId: sessionId ?? undefined }));
  });
  const evaluate = async (expression, sessionId) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(out, `${name}.png`), Buffer.from(data, "base64"));
  };
  mainSession = (await send('Target.attachToTarget',{targetId:tabs.find(tab=>tab.type==='page').id,flatten:true},null)).sessionId;
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.enable");


  const waitFor = async (expression, sessionId) => { for(let i=0;i<300;i++){if(await evaluate(expression,sessionId))return;await sleep(100);}throw new Error(`Missing ${expression}`); };
  const results=[];
  for (const type of ["pdf","markdown"]) {
    await send("Emulation.setDeviceMetricsOverride",{width:650,height:900,deviceScaleFactor:1,mobile:false});
    await send("Page.navigate",{url:`http://127.0.0.1:1452/scripts/merge-preview-review.html${type==="markdown"?"?markdown":""}`});
    await waitFor('Boolean(window.reviewReady)');await evaluate('window.setReviewMerge(true)');
    await waitFor(`document.querySelectorAll('.lc-hub-conflict-preview[aria-busy="false"]').length===2`);
    if(type==='pdf') {
      await evaluate(`document.querySelector('.lc-hub-conflict-pane [data-note-id="note-50"]').click()`);
      await waitFor(`Array.from(document.querySelectorAll('.lc-hub-conflict-preview')).every(p=>[...p.querySelectorAll('canvas[data-ink-page="50"]')].some(c=>c.width>0))`);
    }
    for(const width of [650,1920,1000,2560,650]) {
      await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});await sleep(1000);
      const panes=await evaluate(`Array.from(document.querySelectorAll('.lc-hub-conflict-preview')).map(p=>({width:p.clientWidth,visible:[...p.querySelectorAll('[data-pdf-page]')].filter(el=>{const b=el.getBoundingClientRect(),r=p.getBoundingClientRect();return b.bottom>r.top && b.top<r.bottom}).map(el=>el.dataset.pdfPage),busy:p.getAttribute('aria-busy'),marks:p.querySelectorAll('[data-footnote-id]').length,ink:[...p.querySelectorAll('canvas[data-ink-tile]')].map(c=>({width:c.width,height:c.height,alpha:c.width>0&&c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)}))}))`);
      for(const pane of panes) {
        assert(pane.ink.some(tile=>tile.alpha),`Ink vanished at ${width}px`);
        if(type==='pdf') {assert(pane.visible.includes('50'),`Resize moved off page 50 at ${width}px`);assert(pane.marks>0,`Page 50 mark vanished at ${width}px`);}
      }
      console.log(JSON.stringify({type,width,panes}));results.push({type,width,panes});
      if(width===1920)await shot(`resize-${type}`);
    }
  }
  await send("Emulation.setDeviceMetricsOverride",{width:650,height:900,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url:'http://127.0.0.1:1452/scripts/annotation-resize-review.html'});
  await waitFor('Boolean(window.reviewReady)');await sleep(1000);
  for(const width of [650,1920,1000,2560,650]) {
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});await sleep(1300);
    const data=await evaluate(`(()=>{const c=document.querySelector('.lc-ink-lab-canvas'),m=document.querySelector('[data-footnote-id] .lc-doc-footnote-band'),p=document.querySelector('[data-pdf-page="50"]');return {page:p&&p.getBoundingClientRect().toJSON(),mark:m&&m.getBoundingClientRect().toJSON(),canvas:c&&{alpha:c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0),width:c.width,height:c.height,transform:c.style.transform,box:c.getBoundingClientRect().toJSON()},state:window.reviewBoard.saveBoard({assembleInk:false}).appState}})()`);
    assert(data.page.top>-30 && data.page.top<30,`Reader left page 50 at ${width}px`);
    assert(data.canvas.alpha,`Reader ink vanished at ${width}px`);
    assert(data.mark && data.mark.top>0 && data.mark.top<900,`Reader footnote vanished at ${width}px`);
    console.log(JSON.stringify({reader:true,width,data}));await shot(`reader-resize-${width}`);
  }
  console.log(JSON.stringify({errors}));
} finally {socket?.close();chrome.kill();server.kill();}
