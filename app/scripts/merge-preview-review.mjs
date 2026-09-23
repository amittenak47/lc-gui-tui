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
  await send("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:2,mobile:false});
  await send("Performance.enable");
  for (const type of ["pdf", "markdown"]) {
    await send("Page.navigate",{url:`http://127.0.0.1:1452/scripts/merge-preview-review.html${type==="markdown"?"?markdown":""}`});
    await waitFor('Boolean(window.reviewReady)');
    await evaluate(`window.reviewLongTasks=[];new PerformanceObserver(list=>window.reviewLongTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask'})`);
    const cycles=[];
    const memory=async()=>{
      await send('HeapProfiler.collectGarbage');
      const metrics=(await send('Performance.getMetrics')).metrics;
      return {heap:metrics.find(m=>m.name==='JSHeapUsedSize').value,...await evaluate(`({canvases:document.querySelectorAll('canvas').length,mergeCanvasBytes:[...document.querySelectorAll('.lc-hub-conflict canvas')].reduce((n,c)=>n+c.width*c.height*4,0),canvasBytes:[...document.querySelectorAll('canvas')].reduce((n,c)=>n+c.width*c.height*4,0)})`)};
    };
    const baseline=await memory();
    for(let cycle=0;cycle<3;cycle++) {
      const start=Date.now();
      await evaluate('window.setReviewMerge(true)');
      await waitFor(`document.querySelectorAll('.lc-hub-conflict-preview[aria-busy="false"]').length===2`);
      const readyMs=Date.now()-start;
      const annotations=await evaluate(`Array.from(document.querySelectorAll('.lc-hub-conflict-pane')).map(p=>({marks:p.querySelectorAll('[data-footnote-id]').length,ink:[...p.querySelectorAll('canvas[data-ink-tile]')].some(c=>c.width>0&&c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0))}))`);
      for(const pane of annotations){assert(pane.marks>0,JSON.stringify({type,annotations}));assert(pane.ink,JSON.stringify({type,annotations}));}
      const jumps=[];
      if(type==='pdf') {
        const alignment=await evaluate(`Array.from(document.querySelectorAll('.lc-hub-conflict-preview')).map(p=>{const page=p.querySelector('[data-pdf-page="1"]').getBoundingClientRect(),band=p.querySelector('[data-footnote-id="note-1"] .lc-doc-footnote-band').getBoundingClientRect(),scale=page.width/1100;return {dx:band.left+band.width/2-(page.left+271*scale),dy:band.top+band.height/2-(page.top+131*scale)}})`);
        assert(alignment.every(a=>Math.abs(a.dx)<1&&Math.abs(a.dy)<1),JSON.stringify(alignment));
        // Visit a page with no clicked entry: its ink must load from the viewport.
        await evaluate(`document.querySelectorAll('.lc-hub-conflict-preview').forEach(p=>{const page=p.querySelector('[data-pdf-page="73"]');p.scrollTop+=page.getBoundingClientRect().top-p.getBoundingClientRect().top;})`);
        await waitFor(`window.reviewFetched.includes(73)&&Array.from(document.querySelectorAll('.lc-hub-conflict-preview')).every(p=>[...p.querySelectorAll('canvas[data-ink-page="73"]')].some(c=>c.width>0))`);
      }
      if(type==='pdf') for(const page of [25,50,100,1]){
        const at=Date.now();
        await evaluate(`document.querySelector('.lc-hub-conflict-pane [data-note-id="note-${page}"]').click()`);
        await waitFor(`Array.from(document.querySelectorAll('.lc-hub-conflict-preview')).every(p=>{const el=p.querySelector('[data-pdf-page="${page}"]');return el&&Math.abs(el.getBoundingClientRect().top-p.getBoundingClientRect().top)<30})`);
        const scrollMs=Date.now()-at;
        await waitFor(`Array.from(document.querySelectorAll('.lc-hub-conflict-preview')).every(p=>p.querySelector('[data-pdf-page="${page}"][data-painted]')&&[...p.querySelectorAll('canvas[data-ink-page="${page}"]')].some(c=>c.width>0)&&p.querySelector('[data-footnote-id="note-${page}"]'))`);
        jumps.push({page,scrollMs,paintMs:Date.now()-at});await sleep(250);
      }
      await sleep(500);
      const opened=await memory();
      if(cycle===0)await shot(`merge-${type}`);
      await evaluate('window.setReviewMerge(false)');await sleep(600);
      const closed=await memory();
      cycles.push({readyMs,annotations,jumps,opened,closed});
      assert(closed.heap<baseline.heap+40*1024*1024,JSON.stringify({type,baseline,closed}));
      console.log(JSON.stringify({type,cycle,readyMs,jumps,baseline,opened,closed}));
      assert(opened.mergeCanvasBytes<64*1024*1024,JSON.stringify({type,opened}));
    }
    results.push({type,baseline,cycles,longTasks:await evaluate('window.reviewLongTasks')});
  }
  await writeFile(resolve(out,'merge-results.json'),JSON.stringify({results,errors},null,2));
  assert.equal(errors.length,0,JSON.stringify(errors));console.log(JSON.stringify(results));
} finally {socket?.close();chrome.kill();server.kill();}
