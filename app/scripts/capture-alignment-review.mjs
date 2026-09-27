// Isolated Chrome profile and Vite port; never reads the live app's storage.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=resolve(`../.tmp-phase3-checks/library-${process.pid}`);
await mkdir(profile,{recursive:true});
const port=1480,children=[];let socket;
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
  await send("Emulation.setDeviceMetricsOverride",{width:1000,height:900,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/scripts/pinch-review.html?markdown&scroll`});
  await sleep(600);for(let i=0;i<300&&!await evaluate('Boolean(window.reviewReady)');i++)await sleep(100);
  await sleep(1500);
  for(const index of [2,20,60]){
    const result=await evaluate(`(async()=>{
      const b=window.reviewBoard,root=document.querySelector('.lc-board');
      const frames=b.readingPageFrames();b.jumpToPageFrame(frames[Math.min(${index},frames.length-1)]);await new Promise(r=>setTimeout(r,500));
      const heading=[...root.querySelectorAll('.lc-md-ink-doc h2')].find(h=>{const r=h.getBoundingClientRect();return r.top>150});
      if(!heading)throw Error('No visible heading');
      const marker=document.createElement('div');marker.style.cssText='width:100px;height:3px;background:rgb(0,0,255);';heading.after(marker);
      await new Promise(r=>setTimeout(r,200));
      const rect=marker.getBoundingClientRect(),rb=root.getBoundingClientRect(),view=b.getViewportBounds();
      const x=view.x+(rect.left-rb.left)/view.zoom,y=view.y+(rect.top+rect.height/2-rb.top)/view.zoom;
      b.setInkOps([{kind:'draw',color:'#ff0000',baseWidth:3,pressureSensitive:false,points:[{x:x+200,y,pressure:.5},{x:x+300,y,pressure:.5}]}]);
      const crop={x:x-10,y:y-80,width:350,height:160};
      const c=await b.captureSceneFrame(crop,1);if(!c)throw Error('No capture');
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let red=0,blue=0,ry=0,by=0;
      for(let i=0;i<d.length;i+=4){const y=Math.floor(i/4/c.width);if(d[i]>180&&d[i+1]<50&&d[i+2]<50){red++;ry+=y}if(d[i]<50&&d[i+1]<50&&d[i+2]>180){blue++;by+=y}}
      marker.remove();return {index:${index},red,blue,redY:ry/red,blueY:by/blue,delta:by/blue-ry/red,png:c.toDataURL().split(',')[1]};
    })()`);
    const {png,...stats}=result;results.push(stats);console.log(JSON.stringify(stats));
    await writeFile(resolve(profile,`capture-${index}.png`),Buffer.from(png,'base64'));
  }
  console.log(profile);
  assert(results.every(r=>r.red>0&&r.blue>0&&Math.abs(r.delta)<1.5),JSON.stringify(results));
}finally{socket?.close();for(const child of children.reverse())child.kill();}
