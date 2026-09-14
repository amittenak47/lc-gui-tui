// Run with Vite on 127.0.0.1:1427. Chrome uses an isolated profile.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const out = resolve(".tmp-viz-review/annotation-ui");
await mkdir(out, { recursive: true });
const profile = resolve(out, `chrome-${process.pid}`);
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1427", "--strictPort"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
    try { await fetch("http://127.0.0.1:1427/", { signal: AbortSignal.timeout(1000) }); break; } catch { await sleep(100); }
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  if (process.argv.includes("--doodle")) {
    await send("Page.navigate", { url: "http://127.0.0.1:1427/scripts/annotation-ui-review.html?doodle=1" });
    for (let i = 0; i < 200; i++) {
      if (await evaluate("Boolean(document.querySelector('.lc-loading-doodle'))")) break;
      await sleep(100);
    }
    await sleep(300);
    const pixels = () => evaluate(`(()=>{const c=document.querySelector('canvas');const ctx=c.getContext('2d');const d=ctx.getImageData(0,0,c.width,c.height).data;let left=0,right=0;for(let y=380;y<420;y++)for(let x=400;x<1100;x++){if(d[(y*c.width+x)*4+3]>0){if(x<700)left++;else right++;}}return {left,right}})()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 400, y: 400, button: "left", clickCount: 1 });
    for (let x = 410; x <= 1100; x += 10) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 400, button: "left", buttons: 1 });
    await sleep(100);
    const live = await pixels();
    console.log("doodle while down", live);
    await shot("doodle-live");
    assert(live.left > 0 && live.right > 0, "Live ink missing outside the default bitmap dimensions");
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1100, y: 400, button: "left", clickCount: 1 });
    await sleep(7600);
    const trail = await pixels();
    console.log("doodle mid-erase", trail);
    await shot("doodle-trail");
    assert(trail.left === 0 && trail.right > 0, "Erase did not sweep from oldest to newest");
    await sleep(1100);
    const gone = await pixels();
    assert(gone.left === 0 && gone.right === 0, "Expired ink remains");
    console.log("Live ink and progressive trailing erase passed.");
  } else if (process.argv.includes("--app")) {
    await send("Page.navigate", { url: "http://127.0.0.1:1427/" });
    const waitFor = async (selector) => {
      for (let i = 0; i < 300; i++) {
        if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return;
        await sleep(100);
      }
      throw new Error(`Missing ${selector}: ${await evaluate('document.body.innerText.slice(0,1000)')}`);
    };
    const press = async (selector, ms = 0) => {
      await waitFor(selector);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
      await sleep(600);
      const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}); const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      if (ms) await sleep(ms);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
      await sleep(300);
    };
    await waitFor(".lc-home-chooser");
    if (await evaluate('Boolean(document.querySelector(`[aria-label$="Continue without LLM"]`))')) await press('[aria-label$="Continue without LLM"]', 600);
    await press('.lc-home-chooser [aria-label^="Annotate"]');
    await sleep(1500);
    if (await evaluate('Boolean(document.querySelector(`[aria-label$="Continue without LLM"]`))')) {
      await press('[aria-label$="Continue without LLM"]', 600);
      if (!await evaluate('Boolean(document.querySelector(`[aria-label="Hold to confirm: Open document"]`))')) await press('.lc-home-chooser [aria-label^="Annotate"]');
    }
    console.log("entry", await evaluate('document.body.innerText.slice(0,1200)'));
    // Override only the native picker UI; the app's real change/read/open path runs.
    await evaluate(`(()=>{const original=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type!=='file')return original.call(this);}})()`);
    await press('[aria-label="Hold to confirm: Open document"]', 600);
    await waitFor('input[type="file"]');
    const { root } = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"]' });
    await send("DOM.setFileInputFiles", { nodeId, files: [resolve(process.argv[2] === "--app" ? ".tmp-dpv-scroll.md" : process.argv[2])] });
    await waitFor(".lc-md-ink-doc h1");
    await sleep(3500);
    await shot("app-before");
    const before = await evaluate(`({top:document.querySelector('.lc-md-ink-doc').getBoundingClientRect().top,body:document.body.innerText.slice(-1000),classes:document.querySelector('.lc-board').className})`);
    console.log("app before", JSON.stringify(before));
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 900 });
    await sleep(1000);
    const after = await evaluate("document.querySelector('.lc-md-ink-doc').getBoundingClientRect().top");
    console.log("app wheel", after);
    await shot("app-after");
    assert(after < before.top - 100, "Normal file-open flow did not scroll");
    console.log("Normal app file-open and wheel scroll passed.");
  } else {
  await send("Page.navigate", { url: "http://127.0.0.1:1427/scripts/annotation-ui-review.html" + (process.argv[2] ? "?file=" + encodeURIComponent(process.argv[2]) : "") });
  for (let i = 0; i < 500; i++) {
    if (await evaluate("Boolean(window.reviewReady)")) break;
    if (i % 100 === 99) console.log("Waiting for document", JSON.stringify({ errors, requests: [...requests.values()] }));
    await sleep(100);
  }
  const inspect = () => evaluate(`({ready:window.reviewReady, viewport:window.reviewBoard?.getViewportBounds(), frames:window.reviewBoard?.getElements().filter(el=>el.id==='lcmdink-0-frame'), docs:[...document.querySelectorAll('.lc-md-ink-doc')].map(el=>({height:el.scrollHeight,rect:el.getBoundingClientRect().toJSON()})), slots:[...document.querySelectorAll('.lc-page-content-slot')].map(el=>({height:el.style.height,transform:el.style.transform})), body:document.body.innerText.slice(0,300)})`);
  const before = await inspect();
  console.log("before", JSON.stringify(before));
  console.log("errors", JSON.stringify(errors));
  console.log("pending requests", JSON.stringify([...requests.values()]));
  await shot("markdown-before");
  assert(before.ready, "Board did not become ready");
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 900 });
  await sleep(800);
  const after = await inspect();
  console.log("after wheel", JSON.stringify(after));
  await shot("markdown-after-wheel");
  assert(after.viewport.y > before.viewport.y + 100, "Wheel did not scroll Markdown");
  await sleep(1500);
  const settled = await inspect();
  assert(Math.abs(settled.frames[0].height - after.frames[0].height) < 2, "Document frame keeps growing while idle");
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 640, y: 700 }] });
  for (let y = 650; y >= 250; y -= 50) {
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 640, y }] });
    await sleep(20);
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(800);
  const touch = await inspect();
  console.log("after touch", JSON.stringify(touch));
  assert(touch.viewport.y > settled.viewport.y + 100, "Touch drag did not scroll Markdown");
  await shot("markdown-after-touch");
  await writeFile(resolve(out, "results.json"), JSON.stringify({ before, after, settled, touch, errors }, null, 2));
  console.log("Markdown wheel, touch, and stable bounds passed.");
  }
} finally {
  socket?.close();
  chrome.kill();
  server.kill();
}
