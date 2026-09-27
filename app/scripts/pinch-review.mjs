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
  for(const query of ['markdown','markdown&spread','pdf','pdf&scroll','pdf&scroll&boundary','markdown&scroll','whiteboard']){
    await send('Page.navigate',{url:`http://127.0.0.1:${port}/scripts/pinch-review.html?${query}`});
    await sleep(600);
    for(let i=0;i<300&&!await evaluate('Boolean(window.reviewReady)');i++)await sleep(100);
    await sleep(1500);
    if(query.includes('boundary')){
      await evaluate(`(()=>{const b=window.reviewBoard,v=b.getViewportBounds(),target=b.readingPageFrames()[2].maxY-250;document.querySelector('.lc-board').dispatchEvent(new WheelEvent('wheel',{deltaY:(target-v.y)*v.zoom/1.55,clientX:500,clientY:460,bubbles:true,cancelable:true}))})()`);
      await sleep(200);
    }
    const data=await evaluate(`(async()=>{
      const b=window.reviewBoard,root=document.querySelector('.lc-board'),ink=root.querySelector('.lc-ink-lab-canvas');
      const before=b.getViewportBounds(),held=b.readingPageBox(),start=performance.now(),samples=[];
      const fire=(type,id,x)=>root.dispatchEvent(new PointerEvent(type,{pointerType:'touch',pointerId:id,isPrimary:id===11,clientX:x,clientY:460,buttons:type==='pointerup'?0:1,bubbles:true,cancelable:true}));
      fire('pointerdown',11,400);fire('pointerdown',12,600);
      const draws=window.pinchStats.draws;
      for(let i=0;i<40;i++){
        const d=100+i*3;
        fire('pointermove',11,500-d);fire('pointermove',12,500+d);
        await new Promise(r=>requestAnimationFrame(r));
        samples.push({t:performance.now()-start,view:b.getViewportBounds(),draws:window.pinchStats.draws,visibility:ink.style.visibility,bitmap:[ink.width,ink.height],transform:ink.style.transform,scopeHeight:parseFloat(root.querySelector('.lc-page-mask > div')?.style.height ?? '0')/b.getViewportBounds().zoom});
      }
      const during=b.getViewportBounds();
      fire('pointerup',11,283);fire('pointerup',12,717);
      await new Promise(r=>setTimeout(r,1800));
      return {before,held,afterHeld:b.readingPageBox(),draws,during,after:b.getViewportBounds(),samples,visibility:ink.style.visibility,transform:ink.style.transform,afterDraws:window.pinchStats.draws};
    })()`);
    if(query.includes('boundary'))assert(data.samples[1].scopeHeight>2500 && data.samples[1].scopeHeight<3200,'Boundary pinch did not retain exactly two PDF pages');
    results.push({query,...data});
    await writeFile(resolve(profile,query.replaceAll('&','-')+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  const wheel=await evaluate(`(async()=>{const b=window.reviewBoard,root=document.querySelector('.lc-board'),before=b.getViewportBounds().zoom;const draws=window.pinchStats.draws;for(let i=0;i<8;i++){root.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-8,clientX:500,clientY:460,bubbles:true,cancelable:true}));await new Promise(r=>requestAnimationFrame(r))}const during=b.getViewportBounds().zoom,duringDraws=window.pinchStats.draws;await new Promise(r=>setTimeout(r,1200));return {before,during,after:b.getViewportBounds().zoom,draws,duringDraws,transform:root.querySelector('.lc-ink-lab-canvas').style.transform}})()`);
  assert(wheel.during>wheel.before);assert.equal(wheel.draws,wheel.duringDraws);assert.equal(wheel.during,wheel.after);assert.equal(wheel.transform,'');
  await writeFile(resolve(profile,'results.json'),JSON.stringify({results,wheel,exceptions},null,2));
  console.log(JSON.stringify({profile,results:results.map(r=>({query:r.query,before:r.before.zoom,during:r.during.zoom,after:r.after.zoom,draws:r.draws,duringDraws:r.samples.at(-1).draws,afterDraws:r.afterDraws,visibility:r.visibility,transform:r.transform,maxGap:Math.max(...r.samples.slice(1).map((s,i)=>s.t-r.samples[i].t))})),exceptions}));
  for(const r of results){
    assert(r.during.zoom>r.before.zoom*1.3,`${r.query}: pinch did not zoom`);
    assert(Math.abs(r.during.zoom-r.after.zoom)<.001,`${r.query}: camera snapped on release`);
    assert(r.samples.every(s=>s.draws===r.draws),`${r.query}: pinch redrew ink tiles`);
    assert(r.samples.every(s=>s.visibility!=="hidden"),`${r.query}: pinch hid ink`);
    assert.equal(r.visibility,'');assert.equal(r.transform,'');
    assert.deepEqual(r.held,r.afterHeld,`${r.query}: pinch changed held page`);
  }
  assert.equal(exceptions.length,0,JSON.stringify(exceptions));

}finally{socket?.close();for(const child of children.reverse())child.kill();}
