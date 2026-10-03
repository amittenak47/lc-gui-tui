// From app/: node scripts/sync-http-review.mjs
// First compile the isolated hub from the repo root (rebuild after editing examples/sync_review_hub.rs):
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
const hubDir = resolve(`../.tmp-phase3-checks/http-hub-${process.pid}`);
let hub, hubError = "";
// Restartable, so a check can take the hub down mid-sync and bring it back on the same data.
let hubStarts = 0;
function startHub() {
  const args = hubStarts++ === 0 ? [hubDir] : [hubDir, "--restart"];
  hub = spawn(resolve("../target/debug/examples/sync_review_hub.exe"), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(hub);
  hub.stderr.on("data", data => { hubError += data; });
}
async function hubReady() {
  for (let i = 0; i < 150; i++) {
    if (hub.exitCode !== null) throw new Error(hubError || "Test hub exited");
    try { await fetch("http://127.0.0.1:1458/health", { signal: AbortSignal.timeout(1000) }); return; } catch { await sleep(100); }
  }
  throw new Error("Test hub did not come back");
}
async function stopHub() {
  hub.kill();
  for (let i = 0; i < 50 && hub.exitCode === null && hub.signalCode === null; i++) await sleep(100);
}
startHub();
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
  await b.call("failPage",17);
  await assert.rejects(()=>b.call("discover"),/connection loss/);
  assert.equal(await b.call("hasDocument"),false,"incomplete import exposed a document without its ink");
  await b.call("failPage",null);
  await b.call("traffic",true);
  const received=await b.call("discover");
  const importGets=(await b.call("traffic")).filter(url=>url.includes("/pads/ink/"));
  assert.equal(importGets.length,41);
  assert(importGets.every(url=>/\/\d+$/.test(url)),"import downloaded a whole pad's ink");
  console.log("PASS discovery downloads one page at a time; failed import stays hidden until complete retry");
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
  await b.call("corruptPage",17);
  for(const action of ["keepServer","mergePage"]) {
    await assert.rejects(()=>b.call(action,17),/could not be read/);
    assert.deepEqual((await b.call("inspect")).page17,localConflict,"unreadable remote ink replaced local handwriting");
  }
  await b.call("corruptPage",null);
  console.log("PASS Keep selection and Merge preserve local handwriting when remote ink is unreadable");
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
  // Clock skew. Device B runs an hour slow; both sync the way the app does
  // (since = the hub's last ping time). Pages 18-20 have shared history;
  // page 50 is new on both devices, so it has no shared sync point.
  // Expected-safe cases assert; the suspected loss path reports a FINDING so
  // this check documents today's behaviour until sync stops comparing clocks.
  const HOUR=3600e3;
  await a.call("setClock",0,true);await b.call("setClock",-HOUR,true);
  await a.call("pull");await b.call("pull");
  await b.call("editPage",18,"#b01818");await b.call("push");
  await a.call("pull");
  assert.equal(await a.call("pageColor",18),"#b01818","slow device's edit to a shared page was lost");
  console.log("PASS skew: a slow device's edit to a page with shared history reaches the other device");
  await a.call("editPage",19,"#a01919");await a.call("push");
  await b.call("pull");
  await b.call("editPage",19,"#b01919");await b.call("push");
  await a.call("pull");
  assert.equal(await a.call("pageColor",19),"#b01919","later edit on a slow device lost to an earlier one");
  console.log("PASS skew: a later edit on the slow device wins over an earlier one on the fast device");
  await a.call("setClock",HOUR,true);
  await a.call("editPage",20,"#a02020");await a.call("push");
  await b.call("pull");await b.call("setClock",0,true);
  await b.call("editPage",20,"#b02020");await b.call("push");
  await a.call("pull");
  assert.equal(await a.call("pageColor",20),"#b02020","a fast device's earlier edit beat a later one");
  console.log("PASS skew: an edit after a fast device's edit still wins (versions never go backwards)");
  await a.call("setClock",0,true);await b.call("setClock",-HOUR,true);
  await a.call("pull");await b.call("pull");
  await b.call("editPage",50,"#b05050");
  await a.call("editPage",50,"#a05050");await a.call("push");
  const newBoth=await b.call("pull");
  const bColor=await b.call("pageColor",50);
  if(newBoth.conflicts.length>0) console.log("PASS skew: a page new on both devices is offered as a conflict");
  else if(bColor==="#a05050") console.log("FINDING skew: page new on both devices; the slow device's strokes were replaced without a conflict (silent ink loss)");
  else console.log(`FINDING skew: page new on both devices, no conflict, slow device kept ${bColor}; the other device's strokes never arrive`);
  // Control: the same race with both clocks right is caught as a conflict,
  // so the loss above is the skew, not new pages as such.
  await a.call("setClock",0,true);await b.call("setClock",0,true);
  await a.call("pull");await b.call("pull");
  await b.call("editPage",51,"#b05151");
  await a.call("editPage",51,"#a05151");await a.call("push");
  const control=await b.call("pull");
  assert.equal(control.conflicts.length,1,"page new on both devices with correct clocks was not offered as a conflict");
  assert.equal(await b.call("pageColor",51),"#b05151","correct clocks: local strokes replaced before the conflict was resolved");
  console.log("PASS skew control: with correct clocks the same new-page race is offered as a conflict");
  await b.call("keepServer",51);
  await b.call("setClock",0,false);await a.call("setClock",0,false);
  // Network faults on uploads from B.
  await b.call("editPage",22,"#b02222");
  await b.call("setFault","error500",22);
  assert.match(await b.call("pushWithin",15000),/^error: /);
  assert.equal((await b.call("pageState",22)).synced,false,"a failed upload marked the page synced");
  await b.call("setFault",null);await b.call("push");await a.call("pull");
  assert.equal(await a.call("pageColor",22),"#b02222");
  console.log("PASS fault: a hub error on upload keeps the page unsynced, and the retry delivers it");
  await b.call("editPage",23,"#b02323");
  await b.call("setFault","lostAck",23);
  assert.match(await b.call("pushWithin",15000),/^error: .*reply lost/);
  await b.call("setFault",null);
  const afterLostAck=await b.call("pushWithin",15000);
  if(afterLostAck==="done") {
    assert.equal((await b.call("pageState",23)).synced,true,"retry after a lost reply left the page unsynced");
    await a.call("pull");
    assert.equal(await a.call("pageColor",23),"#b02323");
    console.log("PASS fault: hub saved the page but the reply was lost; the retry recognises its own copy and converges");
  } else console.log(`FINDING fault: hub saved the page but the reply was lost; the retry fails (${afterLostAck})`);
  await b.call("editPage",24,"#b02424");
  await b.call("setFault","hang",24);
  const hang=await b.call("pushWithin",20000);
  if(hang==="still waiting") console.log("FINDING fault: an upload the hub never answers keeps the sync waiting with no timeout (still waiting after 20 s)");
  else console.log(`PASS fault: a hung upload ends the sync (${hang})`);
  const released=await b.call("releaseHung");
  assert.equal(released.result,"done",`released upload did not finish: ${released.result}`);
  await a.call("pull");
  assert.equal(await a.call("pageColor",24),"#b02424");
  console.log("PASS fault: once the hung request is answered, the sync completes and converges");
  await b.call("editPage",26,"#b02626");
  await b.call("setFault","hang",26);
  assert.equal(await b.call("pushWithin",2000),"still waiting");
  await stopHub();
  const midWalk=await b.call("releaseHung");
  assert.match(midWalk.result,/^error: /,"an upload to a stopped hub reported success");
  assert.equal((await b.call("pageState",26)).synced,false,"an upload lost with the hub was marked synced");
  startHub();await hubReady();
  await b.call("push");await a.call("pull");
  assert.equal(await a.call("pageColor",26),"#b02626");
  console.log("PASS fault: hub restarted mid-sync; the edit stays local and unsynced, then converges after the restart");
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
