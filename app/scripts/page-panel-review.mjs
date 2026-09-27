// Isolated Chrome profile and Vite port; never reads the live app's storage.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=resolve(`../.tmp-phase3-checks/library-${process.pid}`);
await mkdir(profile,{recursive:true});
const port=1473,children=[];let socket;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
children.push(server);let errors='';server.stderr.on('data',data=>errors+=data);
try {
  let ready=false;
  for(let i=0;i<150;i++){
    if(server.exitCode!==null)throw new Error(errors||'Isolated Vite exited');
    try{const response=await fetch(`http://127.0.0.1:${port}/scripts/page-panel-review.html`);if(response.ok){ready=true;break;}}catch{}
    await sleep(100);
  }
  assert(ready,'Isolated server did not start');
  const chrome=spawn(process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',[
    '--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{windowsHide:true,stdio:'ignore'});
  children.push(chrome);let debugPort;
  for(let i=0;i<100;i++){try{debugPort=(await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await sleep(100);}}
  assert(debugPort,'Chrome did not start');
  const tabs=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let seq=0;const pending=new Map(),exceptions=[];
  socket.onmessage=({data})=>{const message=JSON.parse(data);if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params);
    const task=pending.get(message.id);if(task){pending.delete(message.id);message.error?task.reject(message.error):task.resolve(message.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},120000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  await send('Runtime.enable');await send('Performance.enable');
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/scripts/page-panel-review.html`});
  for(let i=0;i<300;i++){if(await evaluate('Boolean(window.reviewReady)')){ready=true;break;}if(exceptions.length)throw new Error(JSON.stringify(exceptions));await sleep(100);}




  const results=[];
  await send('Emulation.setDeviceMetricsOverride',{width:1576,height:1348,deviceScaleFactor:1,mobile:false});
  for(const kind of ['markdown','pdf','whiteboard']){
    await send('Page.navigate',{url:`http://127.0.0.1:${port}/scripts/page-panel-review.html?${kind}`});
    await sleep(600);
    for(let i=0;i<300&&!await evaluate('Boolean(window.reviewReady)');i++)await sleep(100);
    await sleep(1400);
    for(const open of [true,false,true,false]){
      const sample=await evaluate(`(async()=>{
        const b=window.reviewBoard,before=b.readingPageFrames(),held=b.readingPageBox(),frames=[];
        const start=performance.now();window.setReviewOpen(${open});
        await new Promise(resolve=>{const tick=()=>{
          const c=document.querySelector('.lc-ink-lab-canvas'),r=c.getBoundingClientRect(),v=b.getViewportBounds();
          const slot=document.querySelector('.lc-page-content-slot')?.getBoundingClientRect();
          frames.push({t:performance.now()-start,v,w:r.width,h:r.height,bitmap:[c.width,c.height],transform:c.style.transform,visibility:c.style.visibility,slot:slot?{x:slot.x,y:slot.y,w:slot.width}:null,motion:!!document.body.dataset.lcPanelMotion});
          if(performance.now()-start<700)requestAnimationFrame(tick);else resolve();
        };requestAnimationFrame(tick)});
        return {before,after:b.readingPageFrames(),held,afterHeld:b.readingPageBox(),frames};
      })()`);

      await sleep(1200);
      sample.settled=await evaluate(`({view:window.reviewBoard.getViewportBounds(),visibility:document.querySelector('.lc-ink-lab-canvas').style.visibility,transform:document.querySelector('.lc-ink-lab-canvas').style.transform})`);
      results.push({kind,open,...sample});
      await writeFile(resolve(profile,`${kind}-${open}.png`),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await evaluate(`(async()=>{window.setReviewOpen(true);await new Promise(r=>setTimeout(r,90));window.setReviewOpen(false)})()`);
    await sleep(1800);
    assert.equal(await evaluate("document.querySelector('.lc-ink-lab-canvas').style.transform"),'',`${kind}: rapid reversal did not settle`);
    assert.equal(await evaluate("document.querySelector('.lc-ink-lab-canvas').style.visibility"),'',`${kind}: rapid reversal hid ink`);
    const pages=await evaluate('window.reviewBoard.readingPageFrames()');
    await send('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:2,mobile:false});await sleep(1500);
    if(kind!=='whiteboard')assert.deepEqual(await evaluate('window.reviewBoard.readingPageFrames()'),pages,`${kind}: window resize repaginated`);
    await send('Emulation.setDeviceMetricsOverride',{width:1576,height:1348,deviceScaleFactor:1,mobile:false});await sleep(1500);
  }
  await writeFile(resolve(profile,'results.json'),JSON.stringify({results,exceptions},null,2));
  for(const r of results){
    assert.deepEqual(r.before,r.after,`${r.kind}: panel recut the document`);
    assert.deepEqual(r.held,r.afterHeld,`${r.kind}: panel changed the held page`);
    assert.equal(r.settled.visibility,'',`${r.kind}: settled ink hidden`);
    assert.equal(r.settled.transform,'',`${r.kind}: settled ink still using temporary pixels`);
    assert(r.frames.every(f=>f.visibility!=="hidden"),`${r.kind}: ink blinked during resize`);
    const moving=r.frames.filter(f=>f.motion);
    assert(new Set(moving.map(f=>`${f.v.x}:${f.v.y}:${f.v.zoom}`)).size>3,`${r.kind}: resize did not animate`);
    for(const f of moving){
      assert.deepEqual(f.bitmap,moving[0].bitmap,`${r.kind}: bitmap reallocated mid-animation`);
      assert(Math.abs(f.w/f.h-moving[0].w/moving[0].h)<.001,`${r.kind}: nonuniform ink scale`);
    }
    for(let i=1;i<r.frames.length;i++){
      const delta=r.frames[i].v.zoom-r.frames[i-1].v.zoom;
      assert(r.open?delta<.001:delta>-.001,`${r.kind}: zoom reversed during panel animation`);
    }
  }
  console.log(JSON.stringify({profile,cases:results.length,exceptions}));
  assert.equal(exceptions.length,0,JSON.stringify(exceptions));

}finally{socket?.close();for(const child of children.reverse())child.kill();}
