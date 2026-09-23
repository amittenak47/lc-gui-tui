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


  const waitFor = async (expression) => { for(let i=0;i<100;i++){if(await evaluate(expression))return;await sleep(100);}throw new Error(`Missing ${expression}`); };
  const click = async (label) => { await evaluate(`document.querySelector('[aria-label="${label}"]').click()`); await sleep(350); };
  const sizes = () => evaluate(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {composer:r('.lc-agent-composer').height,input:r('textarea').height,messages:r('.lc-agent-messages-host').height,main:r('.lc-main').height,side:r('.lc-side').height,scroll:document.querySelector('.lc-agent-messages').scrollTop}})()`);
  const results=[];
  for(const [width,documentType] of [[1280,"markdown"],[800,"markdown"],[1280,"pdf"]]) {
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
        await new Promise(resolve=>{const tick=()=>{const style=getComputedStyle(document.querySelector('.lc-side'));frames.push({at:performance.now()-start,transform:style.transform,clip:style.clipPath});if(performance.now()-start<400)requestAnimationFrame(tick);else resolve()};requestAnimationFrame(tick)});
        removeEventListener('lc-split-resize',listener);
        results.push({open,firstFrame:frames[0].at,maxFrameGap:Math.max(...frames.slice(1).map((f,i)=>f.at-frames[i].at)),settled,movingFrames:new Set(frames.map(f=>f.clip)).size});
      }
      return results;
    })()`);
    if(width===1280)for(const sample of motion){assert(sample.settled.length===1 && sample.settled[0]>=240,JSON.stringify(sample));assert(sample.movingFrames>2,JSON.stringify(sample));}
    await shot(`panel-${width}-${documentType}`);results.push({width,documentType,split,conversation,composer,restored,motion});
  }
  await writeFile(resolve(out,'results.json'),JSON.stringify({results,errors},null,2));
  assert.equal(errors.length,0,JSON.stringify(errors));console.log(JSON.stringify(results));
} finally {socket?.close();chrome.kill();server.kill();}
