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
  if (process.argv.includes('--handedness')) {
    const matrix = [];
    for (const width of [900, 420]) {
      await send('Emulation.setDeviceMetricsOverride', {width,height:1100,deviceScaleFactor:1,mobile:false});
      for (const ink of ['right','left']) for (const ui of ['right','left']) {
        await evaluate(`Promise.all([import('/src/util/inkHandedness.ts'),import('/src/util/uiHandedness.ts')]).then(([a,b])=>{a.saveInkHandedness('${ink}');a.applyHandednessAttr('${ink}');b.saveUiHandedness('${ui}');})`);
        await sleep(300);
        const boxes = await evaluate(`(()=>{
          const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
          return {tabs:box('.lc-header-left'),actions:box('.lc-header-right'),ink:box('.lc-map-chrome-left'),tray:box('.lc-map-chrome-right')};
        })()`);
        assert(ui==='left' ? boxes.actions.right<=boxes.tabs.x+1 : boxes.tabs.right<=boxes.actions.x+1, `Header hand mismatch: ${JSON.stringify({width,ink,ui,boxes})}`);
        const overlap = boxes.ink.width>0 && boxes.tray.width>0 && Math.min(boxes.ink.right,boxes.tray.right)>Math.max(boxes.ink.x,boxes.tray.x)+1 && Math.min(boxes.ink.bottom,boxes.tray.bottom)>Math.max(boxes.ink.y,boxes.tray.y)+1;
        assert(!overlap, `Opposite hand touch targets overlap: ${JSON.stringify({width,ink,ui,boxes})}`);
        assert(boxes.tray.x>=0 && boxes.tray.right<=width+1, `Tray outside viewport: ${JSON.stringify(boxes)}`);
        matrix.push({width,ink,ui,boxes});
        await shot(`hands-${width}-${ink}-${ui}`);
      }
    }
    await writeFile(resolve(out,'handedness-matrix.json'),JSON.stringify(matrix,null,2));
    await evaluate("Promise.all([import('/src/util/inkHandedness.ts'),import('/src/util/uiHandedness.ts')]).then(([a,b])=>{a.saveInkHandedness('right');a.applyHandednessAttr('right');b.saveUiHandedness('right');})");
    await send('Emulation.setDeviceMetricsOverride', {width:900,height:1100,deviceScaleFactor:1,mobile:false});
  }
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
  if (process.argv.includes('--motion')) {
    await evaluate("import('/src/util/agentDisplayPrefs.ts').then(m=>m.saveAgentDisplayPrefs({...m.DEFAULT_AGENT_DISPLAY_PREFS,autoCollapseThinking:true}))");
    await evaluate("document.querySelector('.lc-agent-messages').scrollTop = 0");
    const oldAnimations = await evaluate("[...document.querySelectorAll('.lc-agent-turn')].some(n=>getComputedStyle(n).animationName==='lc-agent-bubble-enter')");
    assert.equal(oldAnimations, false, 'Saved history must stay still');
    await evaluate("window.reviewBeginAgentTurn()");
    await sleep(75);
    const entering = await evaluate(`['motion-user','motion-agent'].map(id=>{const n=document.querySelector('[data-coach-message="'+id+'"]');return {id,animation:getComputedStyle(n).animationName,transform:getComputedStyle(n).transform,origin:getComputedStyle(n).transformOrigin};})`);
    assert(entering.every(n=>n.animation==='lc-agent-bubble-enter'&&n.transform!=='none'), JSON.stringify(entering));
    const footerStart = await evaluate("document.querySelector('[data-coach-message=motion-agent] .lc-agent-turn-footnotes').textContent");
    await sleep(400);
    const footer = await evaluate("document.querySelector('[data-coach-message=motion-agent]').textContent");
    assert(footer.includes('Reasoning · high')&&!footer.includes('got question'),footer);
    assert(footerStart.length < footer.length, 'Pending footer should fill progressively');
    await shot('pending-footer');
    await evaluate("window.reviewThinkingStep()");
    await sleep(90);
    const thinkingPartial = await evaluate("document.querySelector('[data-coach-message=motion-agent] .lc-agent-process-step-body').textContent");
    await sleep(1700);
    const thinkingFull = await evaluate("document.querySelector('[data-coach-message=motion-agent] .lc-agent-process-step-body').textContent");
    assert(thinkingFull.length>thinkingPartial.length && thinkingFull.includes('counted twice'), 'Live thinking must reveal the full detail');
    await shot('thinking-expanded');
    const thinkingHeight = await evaluate("document.querySelector('[data-coach-message=motion-agent]').getBoundingClientRect().height");
    await evaluate("window.reviewCompleteAgentTurn()");
    await sleep(60);
    assert.equal(await evaluate("Boolean(document.querySelector('[data-coach-message=motion-agent] .lc-agent-turn-body'))"),false,'Answer must wait for thinking fold');
    const foldingHeight = await evaluate("document.querySelector('[data-coach-message=motion-agent]').getBoundingClientRect().height");
    assert(foldingHeight<thinkingHeight,'Thinking should fold upward');
    for(let i=0;i<30;i++) {if(await evaluate("Boolean(document.querySelector('[data-coach-message=motion-agent] .lc-agent-turn-body'))"))break;await sleep(20);}
    const partial = await evaluate("document.querySelector('[data-coach-message=motion-agent] .lc-agent-turn-body').textContent");
    await sleep(1600);
    const complete = await evaluate("document.querySelector('[data-coach-message=motion-agent] .lc-agent-turn-body').textContent");
    assert(complete.length > partial.length, 'Answer should still reveal progressively');
    const drawing = '[data-coach-message=draw] .lc-agent-drawing';
    const heights = [];
    heights.push(await evaluate(`document.querySelector('${drawing}').getBoundingClientRect().height`));
    await evaluate(`document.querySelector('${drawing} button').click()`);
    await sleep(70);
    heights.push(await evaluate(`document.querySelector('${drawing}').getBoundingClientRect().height`));
    await sleep(300);
    heights.push(await evaluate(`document.querySelector('${drawing}').getBoundingClientRect().height`));
    assert(heights[0]>heights[1]&&heights[1]>heights[2], `Close should compress: ${heights}`);
    await evaluate(`document.querySelector('${drawing} button').click()`);
    await sleep(70);
    heights.push(await evaluate(`document.querySelector('${drawing}').getBoundingClientRect().height`));
    await sleep(300);
    heights.push(await evaluate(`document.querySelector('${drawing}').getBoundingClientRect().height`));
    assert(heights[2]<heights[3]&&heights[3]<heights[4], `Open should expand: ${heights}`);
    await evaluate(`document.querySelector('${drawing}').scrollIntoView({block:'center'})`);
    await shot('compact-drawing-controls');
    await writeFile(resolve(out,'motion-results.json'),JSON.stringify({entering,footerStart,footer,partial,complete,heights,errors},null,2));
    assert.equal(await evaluate(`document.querySelector('${drawing} .lc-timeline-play').textContent`),'');
    console.log(JSON.stringify({entering,heights,footer}));
  }
  const bounds = () => evaluate(`(() => {
    const header=document.querySelector('.lc-app .lc-header').getBoundingClientRect();
    const sheet=document.querySelector('.lc-side').getBoundingClientRect();
    const panel=document.querySelector('.lc-side');
    return {headerTop:header.top,headerBottom:header.bottom,sheetTop:sheet.top,sheetBottom:sheet.bottom,height:innerHeight,bodyScroll:document.scrollingElement.scrollTop,hidden:getComputedStyle(panel).visibility==='hidden',inert:panel.inert};
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
    assert(parked.hidden && parked.inert && parked.sheetTop>=parked.height,`Closed sheet must be hidden/inert, not a peek bar: ${JSON.stringify(parked)}`);
    assert(parked.headerTop>=0 && parked.bodyScroll===0,`Header drift: ${JSON.stringify(parked)}`);
    if(cycle<2) {
      await evaluate("window.reviewOpenAgent()");
      await sleep(300);
    }
  }
  await shot('agent-drawing-panel');
  await evaluate("document.querySelector('.lc-document-drawing-panel [aria-label=\"Next step\"]').click()");
  await sleep(150);
  assert.equal(await evaluate("document.querySelector('.lc-document-drawing-panel .lc-timeline-count').textContent"),'2 · 2');
  await evaluate("document.querySelector('.lc-document-drawing-panel [aria-label=\"Hide drawing\"]').click()");
  for (let i=0;i<20 && await evaluate("Boolean(document.querySelector('.lc-document-drawing-panel'))");i++) await sleep(100);
  assert.equal(await evaluate("Boolean(document.querySelector('.lc-document-drawing-panel'))"),false);
  await writeFile(resolve(out,'results.json'),JSON.stringify({storage,reload,before,after,editor,cycles,errors},null,2));
  assert(errors.length === 0, `Browser errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({storage,reload,scrollDelta:after.y-before.y,editor}));
} finally {
  socket?.close(); chrome.kill(); server.kill();
}
