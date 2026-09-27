// Isolated Chrome profile and Vite port; never reads the live app's storage.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=resolve(`../.tmp-phase3-checks/library-${process.pid}`);
await mkdir(profile,{recursive:true});
const port=1470,children=[];let socket;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
children.push(server);let errors='';server.stderr.on('data',data=>errors+=data);
try {
  let ready=false;
  for(let i=0;i<150;i++){
    if(server.exitCode!==null)throw new Error(errors||'Isolated Vite exited');
    try{const response=await fetch(`http://127.0.0.1:${port}/scripts/practice-agent-review.html`);if(response.ok){ready=true;break;}}catch{}
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
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/scripts/practice-agent-review.html`});
  for(let i=0;i<300;i++){if(await evaluate('Boolean(window.reviewReady)')){ready=true;break;}if(exceptions.length)throw new Error(JSON.stringify(exceptions));await sleep(100);}


  await send('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false});
  let loaded=false;
  for(let i=0;i<350;i++){
    loaded=await evaluate(`!!document.querySelector('.lc-statement-title') && !document.querySelector('.lc-app-booting,.lc-app-loading,.lc-canvas-loading')`);
    if(loaded)break;
    if(exceptions.length)throw new Error(JSON.stringify(exceptions));
    await sleep(100);
  }
  assert(loaded,'LeetCode workspace did not finish opening');
  const results=[];
  for(const page of ["Problem","Code"]){
    await evaluate(`document.querySelector('.lc-pager [aria-label="${page}"]').click()`);await sleep(1000);
    for(const width of [1200,650,1200]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});await sleep(500);
    for(const open of [true,false,true,false]){
      const point=await evaluate(`(()=>{const r=document.querySelector('.lc-agent-toggle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await sleep(650);
      const data=await evaluate(`(()=>{const p=document.querySelector('.lc-side');if(!p)return {missing:true};const s=getComputedStyle(p),r=p.getBoundingClientRect(),input=p.querySelector('textarea'),q=input?.getBoundingClientRect();return {visibility:s.visibility,opacity:s.opacity,inert:p.inert,panelWidth:r.width,height:r.height,hit:q?document.elementFromPoint(q.x+q.width/2,q.y+q.height/2)?.tagName:null,canvasWidth:document.querySelector('.lc-canvas-wrap:not(.lc-canvas-parked)').getBoundingClientRect().width};})()`);
      assert(!data.missing,`Panel unmounted: ${JSON.stringify({width,open,...data})}`);
      if(open)assert(data.visibility==='visible' && Number(data.opacity)>0 && !data.inert && data.hit==='TEXTAREA',`Panel invisible or blocked: ${JSON.stringify({width,open,...data})}`);
      else assert(data.inert,'Closed panel remains interactive');
      if(width<=900)assert(Math.abs(data.canvasWidth-width)<2,'Narrow panel unexpectedly resized the canvas');
      else assert(Math.abs(data.canvasWidth-(open?width-data.panelWidth:width))<2,'Desktop canvas did not match panel space');
      results.push({page,width,open,...data});
    }
  }
  }
  assert(!exceptions.length,JSON.stringify(exceptions));
  console.log(JSON.stringify({results,artifacts:profile}));

}finally{socket?.close();for(const child of children.reverse())child.kill();}
