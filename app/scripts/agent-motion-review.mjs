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


  const waitFor = async (expression, sessionId) => { for(let i=0;i<100;i++){if(await evaluate(expression,sessionId))return;await sleep(100);}throw new Error(`Missing ${expression}`); };
  const click = async (label) => { await evaluate(`document.querySelector('[aria-label="${label}"]').click()`); await sleep(350); };
  const sizes = () => evaluate(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {composer:r('.lc-agent-composer').height,input:r('textarea').height,messages:r('.lc-agent-messages-host').height,main:r('.lc-main').height,side:r('.lc-side').height,scroll:document.querySelector('.lc-agent-messages').scrollTop}})()`);
  const results=[];
  for(const [width,documentType] of process.argv.includes('--persistence-only') ? [] : [[1280,"markdown"],[800,"markdown"],[1280,"pdf"]]) {
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    await send("Page.navigate",{url:`http://127.0.0.1:1452/scripts/agent-motion-review.html${documentType==="pdf"?"?pdf":""}`});
    await waitFor('Boolean(window.reviewReady)');
    const mainBefore=await evaluate("document.querySelector('.lc-main').getBoundingClientRect().height");
    await evaluate('window.setReviewOpen(true)');await sleep(450);
    const split=await sizes();
    await click('Expand conversation'); const conversation=await sizes();
    assert(conversation.composer<3,`Conversation did not expand: ${JSON.stringify(conversation)}`);
    assert(conversation.messages>split.messages+100);
    await click('Show the chat box');
    await click('Expand chat box');const composer=await sizes();
    assert(composer.messages<3,`Messages did not collapse: ${JSON.stringify(composer)}`);
    assert(composer.input>split.input+100,`Composer did not grow: ${JSON.stringify({split,composer})}`);
    await click('Show the conversation'); const restored=await sizes();
    assert(Math.abs(restored.composer-split.composer)<2);
    if(width===800)assert.equal(restored.main,mainBefore,'Tablet opening resized document');
    await evaluate("document.querySelector('textarea').focus()");
    await send('Input.insertText',{text:'Keep draft'});
    await evaluate("window.setReviewOpen(false)");await sleep(350);
    assert(await evaluate("document.querySelector('.lc-side').inert"),'Closed panel is focusable');
    await evaluate('window.setReviewOpen(true)');await sleep(350);
    assert.equal(await evaluate("document.querySelector('textarea').value"),'Keep draft');
    const motion=await evaluate(`(async()=>{
      const results=[];
      for(const open of [false,true,false,true]){
        const frames=[], settled=[];const start=performance.now();
        const listener=()=>settled.push(performance.now()-start);
        addEventListener('lc-split-resize',listener);
        window.setReviewOpen(open);
        await new Promise(resolve=>{const tick=()=>{const style=getComputedStyle(document.querySelector('.lc-side'));const page=document.querySelector('.lc-page-content-slot').getBoundingClientRect();frames.push({at:performance.now()-start,transform:style.transform,clip:style.clipPath,pageWidth:page.width,pageLeft:page.left});if(performance.now()-start<400)requestAnimationFrame(tick);else resolve()};requestAnimationFrame(tick)});
        removeEventListener('lc-split-resize',listener);
        results.push({open,firstFrame:frames[0].at,maxFrameGap:Math.max(...frames.slice(1).map((f,i)=>f.at-frames[i].at)),settled,movingFrames:new Set(frames.map(f=>f.clip)).size,canvasFrames:new Set(frames.map(f=>Math.round(f.pageWidth))).size,canvasEnd:frames.slice(-10).map(f=>({at:f.at,width:f.pageWidth,left:f.pageLeft}))});
      }
      return results;
    })()`);
    if(width===1280)for(const sample of motion){assert(sample.settled.length===1 && sample.settled[0]>=240,JSON.stringify(sample));assert(sample.movingFrames>2,JSON.stringify(sample));assert(sample.canvasFrames>3,JSON.stringify(sample));const end=sample.canvasEnd.map(f=>f.width);assert(Math.max(...end)-Math.min(...end)<5,JSON.stringify(sample));}
    await shot(`panel-${width}-${documentType}`);results.push({width,documentType,split,conversation,composer,restored,motion});
  }
  await send('Page.navigate',{url:'http://127.0.0.1:1452/scripts/agent-rich-layout-review.html'});
  await waitFor('Boolean(window.checkAnswerLayout)');
  const reveal = await evaluate('window.checkAnswerLayout()');
  assert(reveal.words > 100 && reveal.samples > 20, JSON.stringify(reveal));
  assert.equal(reveal.min, reveal.max, 'Answer reveal changed scroll height');
  results.push({reveal});
  await send('Page.navigate',{url:'http://127.0.0.1:1452/scripts/agent-persistence-review.html'});
  await waitFor('Boolean(window.persistenceReview)');
  await evaluate(`(async()=>{
    const p=window.persistenceReview, parent={kind:'annotate',id:'review-chat'};
    await p.saveCoachRequest('queued',{text:'original',prompt:'original prompt',view:{pages:[2,3],page_text:'frozen document'}});
    const old=await p.loadCoachRequest('queued');
    await p.saveCoachRequest('queued',{...old,text:'edited',prompt:'edited prompt'});
    await p.putParentContent(parent,{artifacts:undefined,source:'local document',agent:p.persistableAgentMessages([
      {id:'queued',role:'user',content:'edited',at:1,requestState:'queued',future:{kept:true}},
      {id:'deleted',role:'user',content:'gone',at:2,deletedAt:20},
      {id:'stopped',role:'assistant',content:'partial',at:3,requestState:'cancelled',pending:false},
    ])});
    await p.putParentContent(parent,{artifacts:undefined,agent:[{id:'deleted',role:'user',content:'gone',at:2}]},{agentOnly:true});
  })()`);
  // Invalidate the old document's ready flag before CDP acknowledges reload;
  // otherwise the first poll can pass before navigation has even started.
  await evaluate('delete window.persistenceReview');
  await send('Page.reload');await waitFor('Boolean(window.persistenceReview)');
  const persisted=await evaluate(`(async()=>{const p=window.persistenceReview;const saved=await p.getContent('review-chat');return {saved,request:await p.requireCoachRequest('queued'),messages:p.restoreAgentMessages(saved.agent)}})()`);
  assert.equal(persisted.request.text,'edited');assert.equal(persisted.request.prompt,'edited prompt');
  assert.deepEqual(persisted.request.view,{pages:[2,3],page_text:'frozen document'});
  assert.equal(persisted.messages[0].content,'edited');assert.equal(persisted.messages[0].requestState,'interrupted');
  assert.equal(persisted.messages[0].future.kept,true);assert.equal(persisted.messages[1].deletedAt,20);
  assert.equal(persisted.messages[2].requestState,'cancelled');assert.equal(persisted.saved.source,'local document');
  const {browserContextId}=await send('Target.createBrowserContext',{},null);
  try {
    const {targetId}=await send('Target.createTarget',{url:'http://127.0.0.1:1452/scripts/agent-persistence-review.html',browserContextId},null);
    const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true},null);
    await waitFor('Boolean(window.persistenceReview)',sessionId);
    const remote=await evaluate(`(async()=>{const p=window.persistenceReview;const messages=p.restoreAgentMessages(${JSON.stringify(persisted.saved.agent)});let retryError;try{await p.requireCoachRequest('queued')}catch(e){retryError=e.message}return {sessions:p.listSessions(messages),retryError,payload:await p.loadCoachRequest('queued')}})()`,sessionId);
    const localSessions=await evaluate(`window.persistenceReview.listSessions(window.persistenceReview.restoreAgentMessages(${JSON.stringify(persisted.saved.agent)}))`);
    assert.deepEqual(remote.sessions,localSessions);assert.equal(remote.payload,undefined);
    assert.match(remote.retryError,/Original request is unavailable/);
    results.push({persistence:'queued edit survived browser reload; isolated device has matching sessions and explicit unavailable Retry'});
  } finally {await send('Target.disposeBrowserContext',{browserContextId},null);}
  await writeFile(resolve(out,'results.json'),JSON.stringify({results,errors},null,2));
  assert.equal(errors.length,0,JSON.stringify(errors));console.log(JSON.stringify(results));
} finally {socket?.close();chrome.kill();server.kill();}
