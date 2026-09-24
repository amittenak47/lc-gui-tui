// From app/: node scripts/sync-http-review.mjs
// First compile the isolated hub from the repo root:
// cargo build --no-default-features --example sync_review_hub
// Real IndexedDB in two isolated Chrome profiles; never opens the user's app data.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = 1459;
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
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/scripts/sync-http-review.html` });
  await ready();
  return { call: (name, ...args) => evaluate(`window.artifactChecks[${JSON.stringify(name)}](...${JSON.stringify(args)})`),
    evaluate, send,
    crash: async () => { await send("Page.crash").catch(() => {}); },
    reload: async () => { await evaluate("delete window.artifactChecks"); await send("Page.reload"); await sleep(200); await ready(); } };
}
const hub = spawn(resolve("../target/debug/examples/sync_review_hub.exe"), [resolve(`../.tmp-phase3-checks/http-hub-${process.pid}`)],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
children.push(hub);
let hubError="";hub.stderr.on("data", data=>{hubError+=data;});
try {
  for(let i=0;i<150;i++) {
    if(hub.exitCode!==null)throw new Error(hubError || "Test hub exited");
    try {
      await fetch("http://127.0.0.1:1458/health",{signal:AbortSignal.timeout(1000)});
      await fetch(`http://127.0.0.1:${port}/scripts/sync-http-review.html`,{signal:AbortSignal.timeout(1000)});break;
    } catch {await sleep(100);}
  }
  const a=await browser("http-a"),b=await browser("http-b");
  const initial=await a.call("seed");
  const received=(await b.call("pull")).state;
  assert.deepEqual(received,initial);
  assert.equal(received.pages.length,40);
  assert.equal(received.metadataHasPayload,false);
  assert.deepEqual(await b.call("selectedRead"),[17]);
  assert.equal(received.scratchInk.ops.length,12);
  assert.equal(received.attachments.find(a=>a.title==="Saved conversation").agent[0].future.kept,true);
  assert.equal(received.attachments.find(a=>a.title==="Owned drawing").ink[0][1].ops.length,12);
  console.log("PASS real HTTP/SQLite + two IndexedDB clients: 40 ink pages, footnotes, scratch board, unknown transcript fields and multi-thread sessions");
  await b.reload();assert.deepEqual(await b.call("inspect"),received);
  await b.call("editPage",17,"#cc0000");await b.call("push");
  await a.call("traffic",true);
  const changed=(await a.call("pull")).state;
  assert.notDeepEqual(changed.page17,initial.page17);
  assert.deepEqual(changed,(await b.call("inspect")));
  const traffic=await a.call("traffic");
  const inkGets=traffic.filter(url=>url.includes("/pads/ink/"));
  assert.deepEqual(inkGets,["http://127.0.0.1:1458/pads/ink/annotate/http-sync-document/17"]);
  console.log("PASS changed-page sync downloads exactly one page and converges in both directions");
  await b.call("editPage",17,"#0000cc");await b.call("push");
  await a.call("failPage",17);
  await assert.rejects(()=>a.call("pull"),/connection loss/);
  assert.deepEqual((await a.call("inspect")).page17,changed.page17);
  await a.call("failPage",null);await a.call("pull");
  assert.deepEqual((await a.call("inspect")).page17,(await b.call("inspect")).page17);
  console.log("PASS interrupted transfer preserves readable local ink; retry converges");
  await a.call("editPage",17,"#008800");await b.call("editPage",17,"#885500");
  const localConflict=(await b.call("inspect")).page17;
  await a.call("push");
  const conflict=await b.call("pull");
  assert.equal(conflict.conflicts.length,1);
  assert.deepEqual(conflict.state.page17,localConflict,"sync overwrote unresolved local strokes");
  const merged=await b.call("mergePage",17);
  assert.equal(merged.page17.ops.length,24);
  assert.deepEqual((await a.call("pull")).state.page17,merged.page17);
  console.log("PASS same-page conflict preserves local ink; explicit Merge keeps both sets of strokes and converges");
  const beforeAttachment=await a.call("inspect");
  await b.call("editConversation");
  await a.call("failAttachments",true);
  await assert.rejects(()=>a.call("pull"),/attachment connection loss/);
  assert.deepEqual(await a.call("inspect"),beforeAttachment,"failed dependency transfer changed local parent");
  await a.call("failAttachments",false);await a.call("pull");
  assert.deepEqual((await a.call("inspect")).attachments,(await b.call("inspect")).attachments);
  console.log("PASS saved message snapshots and owned ink attachments cross HTTP; missing revision preserves parent until retry");
  await a.call("deleteThread");
  const deleted=(await b.call("pull")).state;
  assert(deleted.agent.filter(m=>["q","a"].includes(m.id)).every(m=>m.deletedAt>0));
  assert(!deleted.footnotes[0].threads?.some(t=>t.rootId==="q"),"deleted thread still linked from footnote");
  console.log("PASS deleted thread stays deleted and footnote reference disappears");
  const stale=(await a.call("staleThreadWrite")).state;
  assert(stale.agent.filter(m=>["q","a"].includes(m.id)).every(m=>m.deletedAt>0));
  assert(!stale.footnotes[0].threads?.some(t=>t.rootId==="q"));
  console.log("PASS stale replica cannot resurrect a deleted conversation or its footnote link on the server");
  await b.reload();assert.deepEqual(await b.call("inspect"),deleted);
  const heaps=[];
  for(let i=0;i<5;i++) {
    await a.call("pull");await b.call("pull");
    await b.send("HeapProfiler.collectGarbage");
    heaps.push((await b.send("Runtime.getHeapUsage")).usedSize);
  }
  assert(Math.max(...heaps)-Math.min(...heaps)<8*1024*1024,JSON.stringify(heaps));
  console.log("PASS repeated sync heap stays bounded",JSON.stringify(heaps));
} finally {
  for(const socket of sockets)socket.close();
  for(const child of children.reverse())child.kill();
}
