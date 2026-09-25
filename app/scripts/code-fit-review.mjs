// Isolated Chrome profile and Vite port; never reads the live app's storage.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=resolve(`../.tmp-phase3-checks/library-${process.pid}`);
await mkdir(profile,{recursive:true});
const port=1467,children=[];let socket;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
children.push(server);let errors='';server.stderr.on('data',data=>errors+=data);
try {
  let ready=false;
  for(let i=0;i<150;i++){
    if(server.exitCode!==null)throw new Error(errors||'Isolated Vite exited');
    try{const response=await fetch(`http://127.0.0.1:${port}/scripts/code-fit-review.html`);if(response.ok){ready=true;break;}}catch{}
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
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/scripts/code-fit-review.html`});
  for(let i=0;i<300;i++){if(await evaluate('Boolean(window.reviewReady)')){ready=true;break;}if(exceptions.length)throw new Error(JSON.stringify(exceptions));await sleep(100);}


  const results=[];
  for(const [width,height] of [[1600,900],[390,760],[760,300],[1920,900],[390,760]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await sleep(1700);
    const data=await evaluate(`(()=>{const dock=document.querySelector('.lc-code-dock'),editor=document.querySelector('.view-lines'),line=editor?.querySelector('.view-line');if(!line)return {missing:true};const d=dock.getBoundingClientRect(),l=line.getBoundingClientRect(),badge=document.querySelector('.lc-page-indicator').getBoundingClientRect();return {left:d.left,right:d.right,top:d.top,lineTop:l.top,rows:editor.children.length,layoutWidth:dock.offsetWidth,badgeBottom:badge.bottom,font:getComputedStyle(line).fontSize};})()`);
    assert(!data.missing && data.left>=0 && data.right<=width+1 && data.lineTop>data.badgeBottom,JSON.stringify({width,height,...data}));
    results.push({width,height,...data});
    const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(profile,`code-${width}-${height}.png`),Buffer.from(shot.data,'base64'));
  }
  assert(results.every(row=>row.layoutWidth===results[0].layoutWidth && row.rows===results[0].rows),'Window resize rewrapped code');
  await evaluate('window.setReviewPage("constraints")');await sleep(1500);
  const widths=[];
  for(const width of [390,1600,650]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:760,deviceScaleFactor:1,mobile:false});await sleep(1100);
    widths.push(await evaluate(`document.querySelector('.lc-statement-doc').offsetWidth`));
  }
  assert(widths.every(w=>w===widths[0]&&w>300),JSON.stringify(widths));
  assert(!exceptions.length,JSON.stringify(exceptions));
  console.log(JSON.stringify({results,statementWidths:widths,artifacts:profile}));

}finally{socket?.close();for(const child of children.reverse())child.kill();}
