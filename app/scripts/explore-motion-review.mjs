// Isolated Chrome profile and Vite port; never reads the live app's storage.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=resolve(`../.tmp-phase3-checks/library-${process.pid}`);
await mkdir(profile,{recursive:true});
const port=1468,children=[];let socket;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
children.push(server);let errors='';server.stderr.on('data',data=>errors+=data);
try {
  let ready=false;
  for(let i=0;i<150;i++){
    if(server.exitCode!==null)throw new Error(errors||'Isolated Vite exited');
    try{const response=await fetch(`http://127.0.0.1:${port}/scripts/explore-motion-review.html`);if(response.ok){ready=true;break;}}catch{}
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
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/scripts/explore-motion-review.html`});
  for(let i=0;i<300;i++){if(await evaluate('Boolean(window.reviewReady)')){ready=true;break;}if(exceptions.length)throw new Error(JSON.stringify(exceptions));await sleep(100);}



  await send('Emulation.setDeviceMetricsOverride',{width:1100,height:800,deviceScaleFactor:1,mobile:false});await sleep(1400);
  const positions=()=>evaluate(`Object.fromEntries([...document.querySelectorAll('.lc-explore-node.is-whiteboard')].map(n=>{const r=n.getBoundingClientRect();return [n.textContent.trim(),{x:r.x,y:r.y}]}))`);
  const edgeBefore=await evaluate(`document.querySelector('.lc-explore-beam').getAttribute('d')`);
  await sleep(500);
  const edgeAfter=await evaluate(`document.querySelector('.lc-explore-beam').getAttribute('d')`);
  assert(edgeBefore!==edgeAfter && (edgeAfter.match(/ C/g)||[]).length===8,'Edges did not ripple through multiple bends');
  const before=await positions();
  await evaluate(`document.querySelector('[aria-label="Find a workspace"]').click()`);await sleep(320);
  await evaluate(`document.querySelector('[aria-label="Whiteboards"]').click()`);await sleep(35);
  const early=await positions();assert(await evaluate(`document.querySelectorAll('.lc-explore-node.is-leaving').length`)===8,'Removed nodes disappeared before animation');
  await sleep(130);const middle=await positions();await sleep(300);const after=await positions();
  assert(await evaluate(`document.querySelectorAll('.lc-explore-node').length`)===4,'Filter failed');
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const key=Object.keys(after).sort((a,b)=>distance(before[b],after[b])-distance(before[a],after[a]))[0];
  assert(distance(before[key],after[key])>3,'Fixture did not exercise repositioning');
  assert(distance(early[key],after[key])>1 && distance(middle[key],after[key])>0.1,'Filter jumped to settled positions');
  await evaluate(`document.querySelector('[aria-label="Whiteboards"]').click()`);await sleep(650);
  assert(await evaluate(`document.querySelectorAll('.lc-explore-node').length`)===12,'Clearing filter lost nodes');
  await evaluate(`document.querySelector('.lc-explore-node.is-whiteboard').click()`);await sleep(350);
  assert(await evaluate(`!!document.querySelector('.lc-node-sheet-actions [aria-label="Open"]') && !document.querySelector('.lc-node-sheet-foot') && !!document.querySelector('.lc-node-link-detail')`),'Node sheet did not retain inline navigation and link descriptions');
  const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(profile,'explore-panel.png'),Buffer.from(shot.data,'base64'));
  await evaluate(`document.querySelector('.lc-node-sheet-actions [aria-label="Open in new tab"]').click()`);assert(await evaluate('window.openedNew'),'New tab action lost');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await send('Page.reload');await sleep(1400);
  await evaluate(`document.querySelector('[aria-label="Find a workspace"]').click()`);await sleep(100);
  await evaluate(`document.querySelector('[aria-label="Whiteboards"]').click()`);await sleep(150);
  const reduced=await evaluate(`([...document.querySelectorAll('.lc-explore-node')]).every(n=>n.style.transform.includes('translate3d')) && document.querySelectorAll('.lc-explore-node').length===4`);
  assert(reduced,'Reduced motion nodes were not placed');
  assert(!exceptions.length,JSON.stringify(exceptions));
  console.log(JSON.stringify({before:before[key],early:early[key],middle:middle[key],after:after[key],reduced,artifacts:profile}));

}finally{socket?.close();for(const child of children.reverse())child.kill();}
