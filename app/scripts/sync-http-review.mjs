// From app/: node scripts/sync-http-review.mjs
// First compile the isolated hub from the repo root (rebuild after editing examples/sync_review_hub.rs):
// cargo build --no-default-features --example sync_review_hub
// Real IndexedDB in two isolated Chrome profiles; never opens the user's app data.
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
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
async function browser(label, existingPort, targetId) {
  let debugPort=existingPort;
  if(!debugPort) {
  const profile = resolve(`../.tmp-phase3-checks/${process.pid}-${label}`);
  await mkdir(profile, { recursive: true });
  const child = spawn(process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  children.push(child);
  for (let i = 0; i < 100 && !debugPort; i++) {
    try { debugPort = (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch { await sleep(100); }
  }
  }
  assert(debugPort, "Chrome did not start");
  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const socket = new WebSocket(tabs.find(tab => targetId ? tab.id === targetId : tab.type === "page").webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(); let seq = 0;
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data); const request = pending.get(msg.id);
    if (request) { pending.delete(msg.id); msg.error ? request.reject(msg.error) : request.resolve(msg.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method} ${params.expression ?? ""}`)); }, 30000);
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
    newTab: async () => { const target=await send("Target.createTarget",{url:"about:blank"});return browser(label+"-sibling",debugPort,target.targetId); },
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
  const initialHead=await a.call("head"); assert.equal(initialHead.state,"live"); assert.equal(initialHead.pages.length,42);
  assert(initialHead.book_rev>initialHead.record_rev); assert(initialHead.pages.every(page=>page.rev>0&&page.hash));
  await b.call("failPage",17);
  await assert.rejects(()=>b.call("discover"));
  assert.equal(await b.call("hasDocument"),false,"incomplete import exposed a document without its ink");
  await b.call("failPage",null);await b.call("traffic",true);
  const received=await b.call("discover");assert.deepEqual(received,initial);
  const imports=(await b.call("traffic")).filter(url=>url.includes("/pads/ink/"));
  assert.equal(imports.length,42);assert(imports.every(url=>url.includes("book_rev=")&&url.includes("page_rev=")),"reads must pin both revisions");
  assert.equal(received.scratchInk.ops.length,12);
  assert.equal(received.attachments.find(a=>a.title==="Saved conversation").agent[0].future.kept,true);
  assert.equal(received.attachments.find(a=>a.title==="Owned drawing").ink[0][1].ops.length,12);
  assert.deepEqual(received.attachments.map(a=>a.kind).sort(),["code","markdown","whiteboard"]);
  assert.equal(received.attachments.find(a=>a.kind==="code").source,"def catalog_check():\n    return 'complete code payload'\n");
  const catalog=(await b.call("head")).record.artifacts;
  assert.deepEqual(catalog.artifacts.find(a=>a.content.kind==="code").associations,[{kind:"thread",rootId:"q"}]);
  assert.deepEqual(catalog.artifacts.find(a=>a.content.kind==="whiteboard").associations,[{kind:"footnote",footnoteId:"mark"}]);
  assert.deepEqual(await b.call("selectedRead"),[17]);
  console.log("PASS atomic HTTP commit + coherent browser IDB import: 40 pages, scratch, unknown transcript fields and attachment assets; failed second download publishes nothing");
  await b.reload();assert.deepEqual(await b.call("inspect"),received);
  await b.call("editPage",17,"#cc0000");await b.call("push");
  await a.call("traffic",true);const changed=(await a.call("pull")).state;
  assert.deepEqual(changed,await b.call("inspect"));
  const gets=(await a.call("traffic")).filter(url=>url.includes("/pads/ink/"));assert.equal(gets.length,1);assert(gets[0].includes("/17?book_rev="));
  console.log("PASS unchanged pages never travel; ink-only saves preserve the hub record revision");
  await b.call("editPage",17,"#0000cc");await b.call("push");const beforeFailed=await a.call("inspect");await a.call("failPage",17);
  await assert.rejects(()=>a.call("pull"));assert.deepEqual(await a.call("inspect"),beforeFailed);await a.call("failPage",null);await a.call("pull");
  await a.call("editPage",17,"#008800");await b.call("editPage",17,"#885500");const losing=await b.call("inspect");await a.call("push");
  const conflict=await b.call("pull");assert.equal(conflict.conflicts.length,1);assert.deepEqual(conflict.state,losing);
  await b.call("corruptPage",17);for(const action of ["keepServer","mergePage"]) {await assert.rejects(()=>b.call(action,17));assert.deepEqual(await b.call("inspect"),losing);}
  await b.call("corruptPage",null);const merged=await b.call("mergePage",17);assert.equal(merged.page17.ops.length,24);assert.deepEqual((await a.call("pull")).state.page17,merged.page17);
  assert((await b.call("retained")).filter(copy=>copy.type==="record").length>=2);assert(!(await b.call("traffic")).some(url=>url.endsWith("/pads/ink")),"modern choices wrote live legacy ink");
  console.log("PASS same-page choice preserves complete local/hub alternatives, merges locally, stages and commits once; unreadable preview preserves active content");
  const beforeAttachment=await a.call("inspect");await b.call("editConversation");await a.call("failAttachments",true);
  await assert.rejects(()=>a.call("pull"));assert.deepEqual(await a.call("inspect"),beforeAttachment);await a.call("failAttachments",false);await a.call("pull");
  assert.deepEqual((await a.call("inspect")).attachments,(await b.call("inspect")).attachments);
  await a.call("deleteThread");const deleted=(await b.call("pull")).state;
  assert(deleted.agent.filter(m=>["q","a"].includes(m.id)).every(m=>m.deletedAt>0));assert(!deleted.footnotes[0].threads?.some(t=>t.rootId==="q"));
  const stale=(await a.call("staleThreadWrite")).state;
  assert(stale.agent.filter(m=>["q","a"].includes(m.id)).every(m=>m.deletedAt>0));assert(!stale.footnotes[0].threads?.some(t=>t.rootId==="q"));
  console.log("PASS legacy compatibility: a stale raw record PUT cannot resurrect deleted conversations or their footnote links");
  console.log("PASS attachment acquisition fails without partial parent publication; conversation tombstones remain deleted");
  const HOUR=3600e3;await a.call("setClock",0,true);await b.call("setClock",-HOUR,true);await a.call("pull");await b.call("pull");
  await b.call("editPage",18,"#b01818");await b.call("push");await a.call("pull");assert.equal(await a.call("pageColor",18),"#b01818");
  await a.call("setClock",HOUR,true);await a.call("editPage",20,"#a02020");await a.call("push");await b.call("pull");
  await b.call("editPage",20,"#b02020");await b.call("push");await a.call("pull");assert.equal(await a.call("pageColor",20),"#b02020");
  await a.call("setClock",0,true);await b.call("setClock",-HOUR,true);await a.call("pull");await b.call("pull");
  await b.call("editPage",50,"#b05050");await a.call("editPage",50,"#a05050");await a.call("push");
  assert.equal((await b.call("pull")).conflicts.length,1,"hour-slow new page must need an explicit choice");assert.equal(await b.call("pageColor",50),"#b05050","hour-slow authored ink was silently discarded");
  await b.call("modern","local");await a.call("pull");assert.equal(await a.call("pageColor",50),"#b05050");
  console.log("PASS hard clock-skew regressions: slow/fast successive edits and a divergent newly created page preserve authored content");
  // Real simultaneous clients publish independent pages without a record merge.
  await a.call("editPage",21,"#a02121");await b.call("editPage",22,"#b02222");const recordRev=(await a.call("head")).record_rev;
  const disjoint=await Promise.all([a.call("modern"),b.call("modern")]);assert(disjoint.every(result=>result.status==="synced"));
  await a.call("pull");await b.call("pull");assert.equal((await a.call("head")).record_rev,recordRev);assert.equal(await a.call("pageColor",22),"#b02222");assert.equal(await b.call("pageColor",21),"#a02121");
  console.log("PASS two real browsers concurrently commit different pages; full returned vectors reconcile disjoint heads");
  await b.call("editPage",23,"#b02323");await b.call("traffic",true);await b.call("setFault","lostAck",23);const lost=await b.call("modern");
  assert.equal(lost.status,"synced",JSON.stringify(lost));assert.equal(lost.committed,true);assert.equal((await b.call("pageState",23)).synced,true);await b.call("setFault",null);await a.call("pull");assert.equal(await a.call("pageColor",23),"#b02323");
  const retries=await b.call("commitRequests");assert.equal(retries.length,3);assert.equal(new Set(retries).size,1);
  console.log("PASS every commit reply dropped after execution: one UUID/body receipt confirms the saved version");
  await b.call("editPage",29,"#b02929");await b.call("setFault","lostAck",29);await b.call("loseReceipt",true);
  const unconfirmed=await b.call("modern");assert.equal(unconfirmed.error.kind,"unconfirmed");assert((await b.call("tracking")).lastAttempt);
  await b.reload();await b.call("editPage",29,"#b02930");const recovered=await b.call("modern");assert.equal(recovered.status,"synced");assert.equal(recovered.committed,true);
  assert.equal((await b.call("tracking")).lastAttempt,null);await a.call("pull");assert.equal(await a.call("pageColor",29),"#b02930");
  console.log("PASS restart before acknowledgement recovers the captured receipt and preserves a newer authored edit");
  await b.call("editPage",25,"#b02525");await b.call("traffic",true);await b.call("setFault","error500",25);
  const rejected=await b.call("modern");assert.equal(rejected.error.kind,"stage");assert.equal((await b.call("traffic")).filter(url=>/\/pads\/stage\/.+\/25$/.test(url)).length,3);
  assert.equal((await b.call("pageState",25)).synced,false);assert.equal((await b.call("head")).pages.find(page=>page.page_id===25)?.hash,(await a.call("head")).pages.find(page=>page.page_id===25)?.hash);
  await b.call("setFault",null);await b.call("push");await a.call("pull");assert.equal(await a.call("pageColor",25),"#b02525");
  console.log("PASS all three refused stage attempts preserve local content and publish no partial commit");
  await b.call("editPage",24,"#b02424");await b.call("setFault","hang",24);const start=Date.now();const hang=await b.call("modern",null,50);
  assert.equal(hang.status,"failed");assert.equal(hang.error.kind,"stage");assert(Date.now()-start<3000,"never-answering requests failed to settle");assert.equal((await b.call("pageState",24)).synced,false);
  await b.call("releaseHung");await b.call("push");await a.call("pull");assert.equal(await a.call("pageColor",24),"#b02424");
  console.log("PASS never-answering uploads settle within bounded attempts, remain dirty, and a fresh retry converges");
  await b.call("editPage",26,"#b02626");await stopHub();const offline=await b.call("modern",null,100);assert.equal(offline.status,"failed");assert.equal((await b.call("pageState",26)).synced,false);
  startHub();await hubReady();await b.call("push");await a.call("pull");assert.equal(await a.call("pageColor",26),"#b02626");
  console.log("PASS isolated hub restart retains dirty ink and retry converges");
  // Same-origin browser tabs use the production Web Locks implementation.
  const sibling=await a.newTab();await a.call("editPage",34,"#a03434");await a.call("barrier","commit");
  const held=a.call("modern",null,10000);for(let i=0;i<100&&!(await a.call("barrierState"));i++)await sleep(20);
  assert.equal(await a.call("barrierState"),true);const attempt=(await a.call("tracking")).lastAttempt.uploadId;
  const waiting=sibling.call("cancellable");await sleep(50);await sibling.call("cancel");assert.equal((await waiting).status,"cancelled");
  const second=sibling.call("modern");await sibling.call("editPage",35,"#a03535");
  await sleep(100);assert.equal((await a.call("tracking")).lastAttempt.uploadId,attempt,"second tab replaced an in-flight attempt");
  await a.call("releaseBarrier");const heldResult=await held;assert.equal(heldResult.status,"synced",JSON.stringify(heldResult));assert.match((await second).status,/^(synced|unchanged)$/);
  assert.equal(await a.call("pageColor",35),"#a03535");await b.call("pull");assert.equal(await b.call("pageColor",34),"#a03434");assert.equal(await b.call("pageColor",35),"#a03535");
  console.log("PASS real same-origin Web Locks serialize attempts while ordinary writes remain available; newer data is recaptured without replacing its payload");
  // A prepared download is held off the live store, then an authored edit
  // invalidates the whole CAS rather than being overwritten.
  await b.call("editPage",36,"#b03636");await b.call("push");await a.call("barrier","publish");
  const receiving=a.call("modern");for(let i=0;i<100&&!(await a.call("barrierState"));i++)await sleep(20);
  assert.equal(await a.call("barrierState"),true);await sibling.call("editPage",36,"#a03636");await a.call("releaseBarrier");
  assert.equal((await receiving).status,"needs_choice");assert.equal(await a.call("pageColor",36),"#a03636");await a.call("modern","local");await b.call("pull");assert.equal(await b.call("pageColor",36),"#a03636");
  console.log("PASS deterministic publication barrier rejects a changed read set and preserves the intervening authored edit");
  await b.call("editPage",37,"#b03737");await b.call("push");await a.call("barrier","read");
  const reading=a.call("modern");for(let i=0;i<100&&!(await a.call("barrierState"));i++)await sleep(20);
  assert.equal(await a.call("barrierState"),true);await sibling.call("editPage",37,"#a03737");await a.call("releaseBarrier");
  assert.equal((await reading).status,"needs_choice");assert.equal(await a.call("pageColor",37),"#a03737");await a.call("modern","local");await b.call("pull");
  console.log("PASS delayed pinned reads preserve intervening local ink; cancellation releases a waiting real Web Lock");
  const problem=await a.call("problemSeed");assert.equal(problem.kind,"problem");assert.equal(problem.pages.length,0);assert.equal(problem.record.board.inkC.ops.length,12);
  const receivedProblem=await b.call("problemPull");assert.equal(receivedProblem.board.inkC.ops.length,12);assert.equal(receivedProblem.dataset,"review");
  console.log("PASS record-only problem canvases preserve inline ink through the same atomic protocol");
  assert.match((await a.call("referenceScratch")).status,/^(synced|unchanged)$/);await b.call("pull");
  await a.call("removeScratch");await b.call("scratchPage",2,"#b00202");await b.call("push");
  assert.equal((await a.call("modern")).status,"needs_choice");const scratchServer=await a.call("modern","server");assert.match(scratchServer.status,/^(synced|unchanged)$/,JSON.stringify(scratchServer));
  assert.equal((await a.call("scratchState",1)).ink.ops.length,12);assert.equal((await a.call("scratchState",2)).ink.ops[0].c,"#b00202");
  await b.call("pull");await a.call("removeScratch");await a.call("push");await b.call("scratchPage",3,"#b00303");
  assert.equal((await b.call("modern")).status,"needs_choice");const scratchLocal=await b.call("modern","local");assert.equal(scratchLocal.status,"synced",JSON.stringify(scratchLocal));
  assert.equal((await b.call("scratchState",3)).referenced,true);assert.equal((await b.call("scratchState",3)).ink.ops[0].c,"#b00303");const afterScratchPull=await a.call("pull");assert.equal(afterScratchPull.conflicts.length,0,JSON.stringify({result:afterScratchPull.result,capture:await a.call("capture")}));
  await a.call("removeScratch");await a.call("push");await b.call("scratchPage",4,"#b00404");
  assert.equal((await b.call("modern")).status,"needs_choice");const scratchRemoved=await b.call("modern","server");assert.match(scratchRemoved.status,/^(synced|unchanged)$/,JSON.stringify(scratchRemoved));
  assert.equal((await b.call("scratchState",4)).referenced,false);assert.equal((await b.call("scratchState",4)).ink.ops.length,0);
  assert((await b.call("retained")).some(copy=>copy.pages?.includes(4)));await a.call("pull");
  console.log("PASS scratch removal/new-shard races in both orders require an explicit choice and retain every losing child page");
  await a.call("editConversationLocal","Local attachment conflict");await b.call("editConversationLocal","Hub attachment conflict");await b.call("push");
  assert.equal((await a.call("modern")).status,"needs_choice");const attachmentsChoice=await a.call("modern","server");assert.equal(attachmentsChoice.status,"synced",JSON.stringify(attachmentsChoice));
  const attachmentsAfter=(await a.call("inspect")).attachments;assert(attachmentsAfter.some(item=>item.source==="Local attachment conflict"));assert(attachmentsAfter.some(item=>item.source==="Hub attachment conflict"));await b.call("pull");
  console.log("PASS explicit attachment conflicts preserve both immutable authored sources and commit the reconciled catalog atomically");
  for(const [kind,local,server] of [["code","local code conflict","hub code conflict"],["whiteboard","#a00101","#b00202"]]) {
    await a.call("editCatalogAttachment",kind,local);await b.call("editCatalogAttachment",kind,server);await b.call("push");
    assert.equal((await a.call("modern")).status,"needs_choice");
    const chosen=await a.call("modern","server");assert.equal(chosen.status,"synced",JSON.stringify(chosen));
    const entries=(await a.call("inspect")).attachments.filter(item=>item.kind===kind);
    const authored=entries.map(item=>kind==="code"?item.source:item.ink[0][1].ops[0].c);
    assert(authored.includes(local)&&authored.includes(server),JSON.stringify(authored));
    await b.call("pull");assert.deepEqual((await b.call("inspect")).attachments,(await a.call("inspect")).attachments);
  }
  console.log("PASS code and whiteboard attachment conflicts retain both exact authored versions on both browsers");
  const beforeAttachmentTrash=(await a.call("inspect")).attachments;
  await a.call("catalogLifecycle","delete");await b.call("pull");
  assert.deepEqual((await b.call("inspect")).attachments,[]);
  const tombstones=await b.call("catalog");assert(tombstones.artifacts.every(item=>item.deletedAt!==undefined));
  await a.call("catalogLifecycle","restore");await b.call("pull");
  assert.deepEqual((await a.call("inspect")).attachments,beforeAttachmentTrash);
  assert.deepEqual((await b.call("inspect")).attachments,beforeAttachmentTrash);
  console.log("PASS attachment trash/restore across browsers preserves every payload, association and explicit restoration revision");
  const beforeDelete=await a.call("inspect");assert(beforeDelete.pages.includes(113));
  assert.equal((await a.call("trash")).status,"synced");const gone=await a.call("head");assert.equal(gone.state,"gone");assert(gone.book_rev>initialHead.book_rev);
  const deletedElsewhere=await b.call("modern");assert.equal(deletedElsewhere.error.kind,"gone");assert.equal(await b.call("hasDocument"),true);
  const restored=await a.call("restore");assert.equal(restored.status,"synced",JSON.stringify(restored));const live=await a.call("head");assert.equal(live.state,"live");assert(live.book_rev>gone.book_rev);
  assert.deepEqual(await a.call("inspect"),beforeDelete);assert(live.pages.some(page=>page.page_id===113));
  console.log("PASS atomic delete/restore retains the local book, scratch and empty page 113; a remote deletion never silently removes the other browser's library copy");
  const heaps=[];for(let i=0;i<5;i++){await a.call("pull");await b.call("pull");await b.send("HeapProfiler.collectGarbage");heaps.push((await b.send("Runtime.getHeapUsage")).usedSize);}
  assert(Math.max(...heaps)-Math.min(...heaps)<8*1024*1024,JSON.stringify(heaps));console.log("PASS repeated modern passes retain bounded heap",JSON.stringify(heaps));
} finally {
  for(const socket of sockets)socket.close();
  for(const child of children.reverse())child.kill();
}
