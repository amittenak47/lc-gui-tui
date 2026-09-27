// Isolated Chrome profile and Vite port; never reads the live app's storage.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=resolve(`../.tmp-phase3-checks/library-${process.pid}`);
await mkdir(profile,{recursive:true});
const port=1474,children=[];let socket;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
children.push(server);let errors='';server.stderr.on('data',data=>errors+=data);
try {
  let ready=false;
  for(let i=0;i<150;i++){
    if(server.exitCode!==null)throw new Error(errors||'Isolated Vite exited');
    try{const response=await fetch(`http://127.0.0.1:${port}/scripts/pinch-review.html`);if(response.ok){ready=true;break;}}catch{}
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
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/scripts/pinch-review.html`});
  for(let i=0;i<300;i++){if(await evaluate('Boolean(window.reviewReady)')){ready=true;break;}if(exceptions.length)throw new Error(JSON.stringify(exceptions));await sleep(100);}





  const results=[];
  await send('Emulation.setDeviceMetricsOverride',{width:1000,height:900,deviceScaleFactor:1,mobile:false});
  for(const query of (process.env.UNDO_CASES?.split(',') ?? ['markdown&scroll','pdf&scroll','markdown','pdf','markdown&scroll&fast','pdf&scroll&fast','whiteboard&fast','markdown&scroll&mobile&touchscroll','markdown&scroll&mobile&touchscroll&fast'])) {
    await send('Emulation.setDeviceMetricsOverride',{width:query.includes('mobile')?800:1000,height:900,deviceScaleFactor:query.includes('mobile')?2:1,mobile:query.includes('mobile')});
    await send('Page.navigate',{url:`http://127.0.0.1:${port}/scripts/pinch-review.html?${query}`});
    await sleep(600);
    for(let i=0;i<300&&!await evaluate('Boolean(window.reviewReady)');i++)await sleep(100);
    await sleep(1800);
    const result=await evaluate(`(async()=>{
      const b=window.reviewBoard,root=document.querySelector('.lc-board'),ink=root.querySelector('.lc-ink-lab-canvas');
      const fast=location.search.includes('fast');
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const samples=[];
      const record=label=>{const pixels=ink.getContext('2d').getImageData(0,0,ink.width,ink.height).data;let painted=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])painted++;samples.push({label,count:b.getInkOpCount(),revision:b.getInkRevision(),painted,view:b.getViewportBounds(),visibility:ink.style.visibility});};
      const mode=async label=>{const button=root.querySelector('button[aria-label="'+label+'"]');if(!button)throw Error('Missing '+label);button.click();await wait(fast?40:300);};
      const fire=(type,id,x,y,target=root,pointerType='touch')=>target.dispatchEvent(new PointerEvent(type,{pointerType,pointerId:id,isPrimary:id===11,clientX:x,clientY:y,button:0,pressure:.5,buttons:type==='pointerup'?0:1,bubbles:true,cancelable:true}));
      const pinch=async factor=>{
        fire('pointerdown',11,400,460);fire('pointerdown',12,600,460);
        for(let i=1;i<=20;i++){const d=100*(1+(factor-1)*i/20);fire('pointermove',11,500-d,460);fire('pointermove',12,500+d,460);await new Promise(r=>requestAnimationFrame(r));}
        fire('pointerup',11,500-100*factor,460);fire('pointerup',12,500+100*factor,460);await wait(fast?20:700);
      };
      b.setInkOps([]);await wait(500);
      await mode('Show toolbar');b.setTool('freedraw');await wait(100);
      fire('pointerdown',21,400,460,ink,'pen');
      for(let i=1;i<=20;i++)fire('pointermove',21,400+i*5,460,ink,'pen');
      fire('pointerup',21,500,460,ink,'pen');await wait(100);record('written');
      await mode('Hide toolbar');record('scroll mode');
      await pinch(2);record('zoomed');await pinch(.5);record('unzoomed');
      if(location.search.includes('touchscroll')){fire('pointerdown',11,500,460);for(let i=1;i<=12;i++){fire('pointermove',11,500,460-i);await new Promise(r=>requestAnimationFrame(r));}fire('pointerup',11,500,448);}else root.dispatchEvent(new WheelEvent('wheel',{deltaY:60,clientX:500,clientY:460,bubbles:true,cancelable:true}));await wait(fast?20:700);record('scrolled');
      await mode('Show toolbar');record('annotation');
      const undo=root.querySelector('button[aria-label="Undo"]');if(!undo)throw Error('Missing Undo button');undo.click();await wait(1000);record('undo once');
      return samples;
    })()`);
    results.push({query,samples:result});console.log(JSON.stringify(results.at(-1)));
  }
  await writeFile(resolve(profile,'undo-results.json'),JSON.stringify({results,exceptions},null,2));
  for(const r of results){
    assert.equal(r.samples[0].count,1,`${r.query}: expected exactly one stroke`);
    assert(r.samples.slice(0,-1).every(s=>s.count===1),`${r.query}: navigation changed stroke count`);
    assert(r.samples.at(-2).painted>0,`${r.query}: ink must still be on screen before undo`);
    assert.equal(r.samples.at(-1).count,0,`${r.query}: first undo failed`);
    assert.equal(r.samples.at(-1).painted,0,`${r.query}: first undo left pixels`);
  }
  assert.equal(exceptions.length,0,JSON.stringify(exceptions));
  console.log(JSON.stringify({profile,passed:results.length}));
}finally{socket?.close();for(const child of children.reverse())child.kill();}
