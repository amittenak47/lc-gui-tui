// Run with Vite on 127.0.0.1:1427. Chrome uses an isolated profile.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const out = resolve(".tmp-viz-review/text-box");
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
  await send("Page.navigate", { url: "http://127.0.0.1:1427/scripts/text-box-review.html" });
  for (let i = 0; i < 300; i++) {
    if (await evaluate("Boolean(window.reviewReady)")) break;
    if (errors.length) throw new Error(JSON.stringify(errors));
    await sleep(100);
  }
  assert(await evaluate("Boolean(window.reviewReady)"), `Board not ready: ${JSON.stringify({ errors, requests: [...requests.values()], body: await evaluate('document.body.innerText.slice(0,500)') })}`);
  if (process.argv.includes("--identity")) {
    await evaluate("window.beforeRerender = window.reviewCurrentBoard(); window.reviewTheme('paper')");
    for (let i = 0; i < 100; i++) {
      if (await evaluate("window.reviewCurrentBoard() !== window.beforeRerender")) break;
      await sleep(50);
    }
    assert(await evaluate("window.reviewCurrentBoard() !== window.beforeRerender"), "Expected a refreshed imperative handle");
    assert(await evaluate("window.reviewCurrentBoard().instanceId != null && window.reviewCurrentBoard().instanceId === window.beforeRerender.instanceId"), "Rerender must not look like a pad switch during sync");
    await evaluate("window.reviewClose()");
    for (let i = 0; i < 100; i++) {
      if (await evaluate("window.reviewCurrentBoard() === null")) break;
      await sleep(50);
    }
    assert(await evaluate("window.reviewCurrentBoard() === null"), "Unmount must invalidate the active board");
    await evaluate("window.reviewOpen()");
    for (let i = 0; i < 100; i++) {
      if (await evaluate("Boolean(window.reviewReady)")) break;
      await sleep(50);
    }
    assert(await evaluate("window.reviewReady && window.reviewCurrentBoard().instanceId !== window.beforeRerender.instanceId"), "Remount must still block a stale sync operation");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log("Board identity survives handle refresh; unmount/remount invalidates stale sync.");
    process.exitCode = 0;
  } else {
  await evaluate("document.querySelector('[aria-label=\"Show toolbar\"]').click()");
  await sleep(250);
  const click = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(100);
  };
  const point = (selector) => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const drag = async (from, to) => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (to.x-from.x)*i/8, y: from.y + (to.y-from.y)*i/8, button: "left", buttons: 1 });
      await sleep(20);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", clickCount: 1 });
    await sleep(250);
  };
  const textElement = () => evaluate("window.reviewBoard.getElements().find(el=>el.type==='text'&&!el.isDeleted)");
  const editor = () => evaluate(`(()=>{const t=document.querySelector('textarea.lc-scene-text-editor');const r=t?.getBoundingClientRect();return t?{text:t.value,client:t.clientHeight,scroll:t.scrollHeight,width:t.clientWidth,scrollWidth:t.scrollWidth,height:r.height,font:parseFloat(getComputedStyle(t).fontSize),bg:getComputedStyle(t).backgroundColor,shadow:getComputedStyle(t).boxShadow,focused:document.activeElement===t}:null})()`);
  const sceneAlpha = () => evaluate(`(()=>{const c=document.querySelector('.lc-scene-overlay-canvas');const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let count=0;for(let i=3;i<a.length;i+=4)if(a[i])count++;return count})()`);
  const finish = async () => {
    const p = await point('[aria-label="Finish editing text"]'); await click(p.x,p.y);
    assert.equal(await editor(),null,"Editor did not close");
  };
  if (process.argv.includes("--markdown")) {
    await evaluate("window.reviewDocument('long-markdown')");
    await sleep(1200);
    const scroll = async (label) => {
      const before = await evaluate("window.reviewBoard.getViewportBounds()");
      await send("Input.dispatchMouseEvent", {type:"mouseWheel",x:600,y:450,deltaX:0,deltaY:400});
      await sleep(700);
      const after = await evaluate("window.reviewBoard.getViewportBounds()");
      assert(after.y-before.y>100, `${label}: Markdown stopped scrolling ${JSON.stringify({before,after})}`);
      console.log(label,after.y-before.y);
    };
    await scroll("Before ink");
    for (let i=0;i<5;i++) {
      await evaluate("window.reviewBoard.setTool('freedraw')");
      await drag({x:450,y:350},{x:700,y:370});
      await sleep(1000);
      assert.equal(await evaluate("window.reviewBoard.getInkStrokes().length"),i+1,"Ink was not recorded");
      await scroll(`After stroke ${i+1}`);
    }
    await evaluate(`(async()=>{
      const board=window.reviewBoard;
      const {saveAnnotateDoc,getAnnotateDoc}=await import('/src/util/annotateStore.ts');
      const {inkOpsFrom}=await import('/src/canvas/inkCodec.ts');
      const blob=board.saveBoard();
      if ('pdfPage' in blob.appState) throw new Error('Markdown save still contains a PDF landing page');
      // Legacy files accidentally saved the PDF film's default page 1.
      blob.appState.pdfPage=1;
      await saveAnnotateDoc({id:'text-review-ink',name:'ink.md',hash:'fixture',source:'Fixture',docType:'markdown',board:blob,agent:[],footnotes:[]});
      const saved=await getAnnotateDoc('text-review-ink');
      board.restoreBoard(saved.board.elements,saved.board.appState,{skipFit:true});
      board.setInkOps(inkOpsFrom(saved.board));
      board.restoreView(saved.board.appState);
    })()`);
    await sleep(900);
    assert.equal(await evaluate("window.reviewBoard.getInkStrokes().length"),5,"Saved ink did not restore");
    await scroll("After saving and reopening ink");
    await shot("markdown-after-ink");
    assert.equal(errors.length,0,JSON.stringify(errors));
  } else if (process.argv.includes("--split") || process.argv.includes("--reopen")) {
    const inspectInk = () => evaluate(`(()=>{const ink=document.querySelector('.lc-ink-lab-canvas');const c=document.createElement('canvas');c.width=ink.width;c.height=ink.height;const ctx=c.getContext('2d');ctx.drawImage(ink,0,0);const d=ctx.getImageData(0,0,c.width,c.height).data;let minX=Infinity,minY=Infinity,maxX=-1,maxY=-1,count=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){if(d[(y*c.width+x)*4+3]>40){count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)}}const r=ink.getBoundingClientRect();return {count,paint:{x:r.left+minX/c.width*r.width,y:r.top+minY/c.height*r.height,w:(maxX-minX)/c.width*r.width,h:(maxY-minY)/c.height*r.height},canvas:r.toJSON(),view:window.reviewBoard.getViewportBounds(),strokes:window.reviewBoard.getInkStrokes()}})()`);
    const layout = async (width, left=0) => {
      await evaluate(`(()=>{const root=document.getElementById('root');root.style.width='${width}px';root.style.marginLeft='${left}px';window.reviewBoard.syncLiveBox()})()`);
      await evaluate("window.dispatchEvent(new CustomEvent('lc-split-resize',{detail:{phase:'settle'}}))");
      await sleep(800);
    };
    const pagePoint = () => evaluate(`(()=>{const p=document.querySelector('.lc-pdf-page, .lc-md-ink-doc, .lc-epub-chapter, .lc-code-doc-pre, .lc-web-doc');const r=p.getBoundingClientRect();const view=window.reviewBoard.getViewportBounds();const point=window.reviewBoard.sceneToClient(window.reviewBoard.getInkStrokes()[0].points[0].x,window.reviewBoard.getInkStrokes()[0].points[0].y);return {x:(point.x-r.left)/view.zoom,y:(point.y-r.top)/view.zoom}})()`);
    for (const format of ["pdf", "markdown", "epub", "code", "web"]) {
    await evaluate(`window.reviewDocument(${JSON.stringify(format)}); window.reviewBoard.setInkOps([])`);
    await sleep(700);
    await layout(640,640);
    await evaluate("document.querySelector('[aria-label=\"Show toolbar\"]')?.click()");
    await sleep(250);
    await evaluate("window.reviewBoard.setTool('freedraw')");
    await drag({x:840,y:400},{x:1040,y:420});
    await sleep(1100);
    const split = await inspectInk();
    let savedStrokes = split.strokes;
    const relative = await pagePoint();
    await shot("ink-split");
    if (process.argv.includes("--reopen")) {
      await evaluate(`(async()=>{
        const board=window.reviewBoard;
        const {putInkPages}=await import('/src/util/inkPageStore.ts');
        const dirty=board.takeDirtyInkPages();
        await putInkPages('split-reopen-${format}',dirty,{dirty:true});
        board.markInkPagesFlushed(dirty.keys());
        window.reviewSaved=JSON.parse(JSON.stringify(board.saveBoard({assembleInk:false})));
        window.reviewClose();
      })()`);
      await sleep(250);
      assert.equal(await evaluate("Boolean(document.querySelector('.lc-board'))"),false,"Board did not unmount");
      await evaluate("document.getElementById('root').style.width='1280px';document.getElementById('root').style.marginLeft='0';window.reviewOpen()");
      for(let i=0;i<100;i++) {
        if(await evaluate("window.reviewReady")) break;
        await sleep(100);
      }
      await evaluate(`(async()=>{
        const board=window.reviewBoard, saved=window.reviewSaved;
        const {getInkPages}=await import('/src/util/inkPageStore.ts');
        board.restoreBoard(saved.elements,saved.appState,{skipFit:true});
        board.ingestInkPages(await getInkPages('split-reopen-${format}'));
        board.syncDocumentScrollBounds();
        await board.settleFitView();
        board.restoreView(saved.appState);
        await board.primeInkSnap();
      })()`);
      await sleep(1100);
      const reopened=await inspectInk();
      // Ink encoding quantizes coordinates; compare later camera transitions
      // against the decoded saved points, not the pre-encoding floats.
      assert.equal(reopened.strokes.length, split.strokes.length);
      for (let i=0;i<split.strokes.length;i++) {
        assert.equal(reopened.strokes[i].points.length, split.strokes[i].points.length);
        for (let j=0;j<split.strokes[i].points.length;j++) {
          const before=split.strokes[i].points[j], after=reopened.strokes[i].points[j];
          assert(Math.abs(before.x-after.x)<=1 && Math.abs(before.y-after.y)<=1,`${format}: save changed ink geometry`);
        }
      }
      savedStrokes = reopened.strokes;
      await shot(`ink-reopened-${format}`);
      console.log(format,"reopened",JSON.stringify({view:reopened.view,paint:reopened.paint,relative:await pagePoint(),count:reopened.count}));
      assert(reopened.count>0,`${format}: reopened ink is missing`);
      const expected=await evaluate(`window.reviewBoard.sceneToClient(${split.strokes[0].points[0].x},${split.strokes[0].points[0].y})`);
      assert(Math.abs(expected.x-reopened.paint.x)<8 && Math.abs(expected.y-reopened.paint.y)<8,`${format}: reopened ink is in the margins ${JSON.stringify({expected,paint:reopened.paint})}`);
      const restoredRelative=await pagePoint();
      assert(Math.abs(relative.x-restoredRelative.x)<1 && Math.abs(relative.y-restoredRelative.y)<1,`${format}: reopening moved ink relative to the page`);
      await layout(640,640);
      const back=await inspectInk();
      assert(back.count>0,`${format}: ink missing after returning to split`);
    }
    await layout(640,0);
    const swapped = await inspectInk();
    const swappedExpected = await evaluate(`window.reviewBoard.sceneToClient(${split.strokes[0].points[0].x},${split.strokes[0].points[0].y})`);
    assert(Math.abs(swappedExpected.x-swapped.paint.x)<8,`${format}: same-size pane move has stale offset`);
    await evaluate("window.reviewPause(true)");
    await sleep(50);
    await layout(1280);
    await evaluate("window.reviewPause(false)");
    await sleep(800);
    const full = await inspectInk();
    await shot("ink-full");
    assert(split.count>0 && full.count>0,"Ink disappeared on leaving split view");
    const stroke = full.strokes[0];
    const expected = await evaluate(`window.reviewBoard.sceneToClient(${stroke.points[0].x},${stroke.points[0].y})`);
    assert(Math.abs(expected.x-full.paint.x)<8 && Math.abs(expected.y-full.paint.y)<8,`${format} split→full ink detached: ${JSON.stringify({expected,paint:full.paint,view:full.view})}`);
    assert.deepEqual(full.strokes,savedStrokes,`${format}: split changed saved ink coordinates`);
    const fullRelative = await pagePoint();
    assert(Math.abs(relative.x-fullRelative.x)<1 && Math.abs(relative.y-fullRelative.y)<1,`${format}: ink moved relative to document content ${JSON.stringify({relative,fullRelative})}`);
    const blob = await evaluate("window.reviewBoard.saveBoard()");
    if (format === "pdf") assert(blob.appState.pdfPage>=1,"PDF landing page was not saved");
    else assert(!("pdfPage" in blob.appState),`${format} saved a PDF landing page`);
    console.log(`${format}: split→full pixels match saved page coordinates`);
    }
  } else {
  await evaluate("window.reviewBoard.setTool('text')");
  await sleep(150);
  await drag({ x:250,y:300 }, { x:730,y:345 });
  assert(await editor(), "Drag did not open editor");
  const raw = "Let B[1..n] be A sorted in increasing order.\nLet T(i) represent the length of the longest divisible subsequence of B[1..i] that includes B[i].";
  await send("Input.insertText", { text:raw });
  await sleep(150);
  const typed = await editor();
  console.log("typing",typed);
  assert(typed.height > typed.font * 2, "Text did not wrap/grow");
  assert(typed.scroll <= typed.client + 1,"Typing is clipped vertically");
  assert(typed.scrollWidth <= typed.width + 1,"Typing overflows width");
  assert.equal(typed.bg,"rgba(0, 0, 0, 0)");
  assert.equal(typed.shadow,"none");
  assert.equal(await sceneAlpha(),0,"Old text is painted beneath editor");
  await shot("text-typing");
  const wheel = await point('.lc-scene-text-controls [role="slider"]');
  await send("Input.dispatchMouseEvent",{type:"mouseWheel",...wheel,deltaX:0,deltaY:-80});
  console.log("wheel hit",await evaluate(`document.elementFromPoint(${wheel.x},${wheel.y})?.outerHTML.slice(0,350)`));
  await sleep(400);
  const resizedFont = await editor();
  assert.notEqual(resizedFont.font,typed.font,"Font size wheel did not change text");
  assert(resizedFont.focused,"Font size wheel lost editor focus");
  assert(resizedFont.scroll <= resizedFont.client + 1,"Font size change clips typing");
  await finish();
  const committed = await textElement();
  console.log("committed layout", committed.text);
  assert.equal(committed.originalText,raw);
  assert(committed.text.split('\n').length>2,"Saved text did not wrap");
  assert(committed.height > committed.fontSize * 2);
  assert(await sceneAlpha()>0,"Committed text is invisible");
  assert(await evaluate("Boolean(document.querySelector('[aria-label=\"Selected text font size\"]'))"));
  await shot("text-selected");
  const handle = await point('[aria-label="Resize text right edge"]');
  await drag(handle,{x:handle.x-150,y:handle.y});
  const narrowed = await textElement();
  assert(narrowed.width<committed.width,"Resize did not narrow wrap width");
  assert.equal(narrowed.fontSize,committed.fontSize,"Resize changed glyph size");
  assert(narrowed.height>=committed.height,"Narrowing did not reflow");
  const editButton = await point('.lc-scene-text-edit-action'); await click(editButton.x,editButton.y);
  const reopened = await editor();
  assert.equal(reopened.text,raw,"Reopening loses original line breaks");
  assert.equal(await sceneAlpha(),0,"Reopened editor leaves ghost text");
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  assert(await editor(),"Enter should insert a newline, not close editing");
  await send("Input.insertText",{text:"Extra line"});
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await sleep(100);
  assert.equal((await textElement()).originalText,raw,"Escape did not cancel changes");
  assert.equal((await textElement()).width,narrowed.width,"Cancel lost resized width");
  await shot("text-final");
  // The real document renderers share this Board stack, including opaque PDF pages.
  await evaluate("window.reviewBoard.setTool('eraser')");
  for (const format of ["pdf", "markdown", "epub", "code", "web"]) {
    await evaluate(`window.reviewDocument(${JSON.stringify(format)})`);
    const selector = {pdf:'.lc-pdf-page[data-painted]',markdown:'.lc-md-ink-doc',epub:'.lc-epub-chapter',code:'.lc-code-doc-pre',web:'.lc-web-doc'}[format];
    for (let i=0;i<100;i++) {
      if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) break;
      await sleep(100);
    }
    assert(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),`${format} did not render`);
    await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:600,y:400});
    await sleep(100);
    const layer = await evaluate(`(()=>{const ring=document.querySelector('.lc-eraser-brush');const style=getComputedStyle(ring);const root=document.querySelector('.lc-page-content-slot');const scene=document.querySelector('.lc-scene-overlay');const result={visible:style.display!=='none',cursor:+style.zIndex,document:+getComputedStyle(root).zIndex,scene:+getComputedStyle(scene).zIndex};ring.style.pointerEvents='auto';result.top=document.elementFromPoint(600,400)===ring;ring.style.pointerEvents='';return result})()`);
    assert(layer.visible && layer.top && layer.cursor>layer.scene && layer.cursor>layer.document,`${format}: cursor is covered ${JSON.stringify(layer)}`);
    await shot(`eraser-${format}`);
    console.log(`${format}: eraser above document and scene layers`);
  }
  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log("Text wrapping, no ghost/shadow, font wheel, resize, reopen and cancel passed.");
  }

  }
} finally {
  socket?.close();
  chrome.kill();
  server.kill();
}
